import { replayState, frameContextMap } from './state.js';

// ── Debugger event listener ────────────────────────────────────────────────────
chrome.debugger.onEvent.addListener((_source, method, params) => {
  if (method === 'Runtime.executionContextCreated') {
    const ctx = params.context;
    if (ctx.auxData?.frameId) {
      frameContextMap.set(ctx.auxData.frameId, ctx.id);
    }
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId !== replayState.tabId || !replayState.active) return;

  console.warn(`[Replay] Debugger detached — reason: "${reason}"`);

  if (reason === 'canceled_by_user') {
    replayState.aborted = true;
    return;
  }

  // Prevent a second detach event from overwriting a re-attach that's already in progress.
  if (replayState.reattachPromise) return;

  // For navigation-induced detachments (e.g. "target_closed" on cross-origin navigation,
  // or when Salesforce SSO redirects through a chrome-extension:// page of their own extension).
  //
  // Problem with polling: `chrome.tabs.get(tabId).url` returns the last committed https URL
  // even while the tab is actively rendering a chrome-extension:// SSO page, so the URL
  // check passes but `chrome.debugger.attach` still fails. The SSO can take 15+ seconds.
  //
  // Solution: event-driven via `chrome.tabs.onUpdated`. We retry the attach on every tab
  // update. When the SSO completes and the tab commits back to the Salesforce https URL,
  // attach finally succeeds. No fixed retry limit — only a 45s hard timeout.
  replayState.reattachPromise = (async () => {
    const tabId = source.tabId;
    let attaching = false;

    try {
      await new Promise((resolve) => {
        const giveUpTimer = setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(onUpdated);
          console.warn('[Replay] Re-attach timed out (45s) — aborting');
          replayState.aborted = true;
          resolve();
        }, 45_000);

        async function tryAttach() {
          if (attaching || replayState.aborted) return;
          attaching = true;
          try {
            const tab = await chrome.tabs.get(tabId).catch(() => null);
            const url = tab?.url ?? '';
            if (!url.startsWith('https://') && !url.startsWith('http://')) {
              attaching = false;
              return; // tab is still on an internal/extension URL — wait for next update
            }
            await chrome.debugger.attach({ tabId }, '1.3');
            await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
            await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
            frameContextMap.clear();
            console.log('[Replay] Debugger re-attached successfully');
            clearTimeout(giveUpTimer);
            chrome.tabs.onUpdated.removeListener(onUpdated);
            resolve();
          } catch (err) {
            attaching = false;
            if (err.message?.includes('already attached')) {
              console.log('[Replay] Debugger already re-attached by Chrome');
              frameContextMap.clear();
              clearTimeout(giveUpTimer);
              chrome.tabs.onUpdated.removeListener(onUpdated);
              resolve();
              return;
            }
            // Attach failed (tab may be mid-SSO or renderer not ready yet).
            // Don't abort — wait for the next onUpdated event to try again.
            console.log(`[Replay] Re-attach attempt failed: ${err.message} — waiting for tab update…`);
          }
        }

        function onUpdated(changedTabId) {
          if (changedTabId !== tabId) return;
          // Small delay for the renderer to initialize before we try to attach.
          setTimeout(tryAttach, 300);
        }

        chrome.tabs.onUpdated.addListener(onUpdated);
        // Also kick off an immediate attempt — tab may already be ready.
        setTimeout(tryAttach, 500);
      });
    } finally {
      replayState.reattachPromise = null;
    }
  })();
});
