import { replayState, frameContextMap, networkState } from "./state.js";

// ── Debugger event listener ────────────────────────────────────────────────────
chrome.debugger.onEvent.addListener((_source, method, params) => {
  if (method === "Runtime.executionContextCreated") {
    const ctx = params.context;
    // Only store main-world contexts (isDefault: true).
    // Isolated worlds (content scripts, extensions) have isDefault: false — if stored,
    // they would overwrite the page's main-world context ID and cause selector evaluation
    // to run in the wrong JS realm (content script isolated world vs. the page itself).
    if (ctx.auxData?.frameId && ctx.auxData?.isDefault !== false) {
      frameContextMap.set(ctx.auxData.frameId, ctx.id);
    }
  }

  // Track in-flight network requests so replay can wait for AJAX-driven content
  // (e.g. wizard steps) to finish loading after a click before continuing.
  if (method === "Network.requestWillBeSent") {
    networkState.pendingCount++;
  }
  if (
    method === "Network.loadingFinished" ||
    method === "Network.loadingFailed"
  ) {
    networkState.pendingCount = Math.max(0, networkState.pendingCount - 1);
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId !== replayState.tabId || !replayState.active) return;

  console.warn(`[Replay] Debugger detached — reason: "${reason}"`);

  if (reason === "canceled_by_user") {
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
        function cleanup() {
          clearTimeout(giveUpTimer);
          chrome.tabs.onUpdated.removeListener(onUpdated);
          chrome.webNavigation.onDOMContentLoaded.removeListener(onNavCommit);
        }

        const giveUpTimer = setTimeout(() => {
          cleanup();
          console.warn("[Replay] Re-attach timed out (45s) — aborting");
          replayState.aborted = true;
          resolve();
        }, 45_000);

        // committedUrl comes from webNavigation.onDOMContentLoaded — it is the real
        // URL of the committed document, unlike chrome.tabs.get().url which can return
        // a stale https:// value while the tab is actually on a chrome-extension:// page
        // (e.g. Salesforce Inspector Reloaded opens its UI inside the current tab).
        async function tryAttach(committedUrl) {
          if (attaching || replayState.aborted) return;

          // Use the confirmed URL from webNavigation when available; otherwise fall back
          // to tabs.get() — but note that tabs.get().url may be stale (see above).
          const url = committedUrl ?? (await chrome.tabs.get(tabId).catch(() => null))?.url ?? "";
          if (!url.startsWith("https://") && !url.startsWith("http://")) {
            return; // tab is on an internal/extension page — wait for a real navigation
          }

          attaching = true;
          try {
            await chrome.debugger.attach({ tabId }, "1.3");
            await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
            await chrome.debugger.sendCommand({ tabId }, "Page.enable");
            await chrome.debugger.sendCommand({ tabId }, "Network.enable");
            networkState.pendingCount = 0;
            await chrome.debugger.sendCommand(
              { tabId },
              "Page.addScriptToEvaluateOnNewDocument",
              {
                source: `(function () {
  const _NativePO = window.PerformanceObserver;
  const _SUPPORTED = new Set([
    "element","event","first-input","largest-contentful-paint",
    "layout-shift","longtask","mark","measure","navigation",
    "paint","resource","visibility-state"
  ]);
  window.PerformanceObserver = function (cb) {
    const wrapped = new _NativePO(list => {
      const entries = list.getEntries().filter(e => _SUPPORTED.has(e.entryType));
      if (entries.length === 0) return;
      cb({ getEntries: () => entries, getEntriesByType: t => entries.filter(e => e.entryType === t), getEntriesByName: (n, t) => entries.filter(e => e.name === n && (!t || e.entryType === t)) });
    });
    this._inner = wrapped;
  };
  window.PerformanceObserver.prototype.observe    = function (o) { return this._inner.observe(o); };
  window.PerformanceObserver.prototype.disconnect = function ()  { return this._inner.disconnect(); };
  window.PerformanceObserver.prototype.takeRecords = function () { return this._inner.takeRecords().filter(e => _SUPPORTED.has(e.entryType)); };
  window.PerformanceObserver.supportedEntryTypes  = _NativePO.supportedEntryTypes;
})();`
              }
            );
            frameContextMap.clear();
            console.log("[Replay] Debugger re-attached successfully");
            cleanup();
            resolve();
          } catch (err) {
            attaching = false;
            if (err.message?.includes("already attached")) {
              console.log("[Replay] Debugger already re-attached by Chrome");
              frameContextMap.clear();
              cleanup();
              resolve();
              return;
            }
            // Attach failed (tab may be mid-SSO or renderer not ready yet).
            // Don't abort — wait for the next event to try again.
            console.log(
              `[Replay] Re-attach attempt failed: ${err.message} — waiting for tab update…`
            );
          }
        }

        // webNavigation.onDOMContentLoaded fires only when a real document commits and
        // provides the actual URL — use this as the primary re-attach trigger so we never
        // attempt to attach while the tab is on a chrome-extension:// page.
        function onNavCommit({ tabId: navTabId, url }) {
          if (navTabId !== tabId) return;
          if (url.startsWith("chrome-extension://")) {
            console.warn(
              "[Replay] Tab navigated to another extension's page — debugger re-attach paused." +
              " Waiting for tab to return to a web page." +
              " (Is 'Salesforce Inspector Reloaded' or another extension intercepting this tab?)"
            );
            return;
          }
          if (!url.startsWith("https://") && !url.startsWith("http://")) return;
          setTimeout(() => tryAttach(url), 300);
        }

        function onUpdated(changedTabId) {
          if (changedTabId !== tabId) return;
          // Secondary trigger (no URL available here — tryAttach will check tabs.get()).
          // Small delay for the renderer to initialize before we try to attach.
          setTimeout(() => tryAttach(null), 300);
        }

        chrome.webNavigation.onDOMContentLoaded.addListener(onNavCommit);
        chrome.tabs.onUpdated.addListener(onUpdated);
        // Also kick off an immediate attempt — tab may already be ready.
        setTimeout(() => tryAttach(null), 500);
      });
    } finally {
      replayState.reattachPromise = null;
    }
  })();
});
