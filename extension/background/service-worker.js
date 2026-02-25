import { MSG, KEEPALIVE_MINS } from '../shared/constants.js';
import { getRecordings, saveRecording, deleteRecording, appendRunResult, getRunHistory } from '../shared/storage.js';
import { executeStep } from '../shared/step-executor.js';

// ── In-memory state ────────────────────────────────────────────────────────────
let recordingState = {
  active: false,
  tabId: null,
  steps: [],
};

let replayState = {
  active: false,
  aborted: false,
  tabId: null,
};

// Clipboard variables that survive cross-site navigation during a run
let clipboardVars = new Map();

// User-defined variables saved during a run via the "Save variable" step
let variables = new Map();

// Execution context map: frameId → executionContextId (populated via Runtime events)
let frameContextMap = new Map();

// Last right-clicked element sent from the content script via STORE_CONTEXT_EL
let lastContextMenuEl = null;

// ── CDP helper ─────────────────────────────────────────────────────────────────
function cdp(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

// ── Broadcast to all extension views ──────────────────────────────────────────
function broadcast(type, payload = {}) {
  chrome.runtime.sendMessage({ type, payload }).catch(() => {});
}

// ── Step detail for progress display ──────────────────────────────────────────
function getStepDetail(step) {
  const sel = step.selectors?.flat?.().find(Boolean) ?? '';
  switch (step.type) {
    case 'navigate':    return step.url ?? '';
    case 'click':
    case 'doubleClick':
    case 'hover':       return sel;
    case 'selectOption': return `${sel} → "${step.label ?? step.value}"`;
    case 'change':      return `${sel}${step.value ? ` → "${step.value}"` : ''}`;
    case 'waitForElement': return sel;
    default:            return sel;
  }
}

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

// ── Service worker keep-alive ──────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'keepAlive') { /* no-op — the alarm itself keeps SW alive */ }
});

function startKeepalive() {
  chrome.alarms.create('keepAlive', { periodInMinutes: KEEPALIVE_MINS });
}
function stopKeepalive() {
  chrome.alarms.clear('keepAlive');
}

// ── Message routing ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const { type, payload } = msg;

  (async () => {
    try {
    switch (type) {

      // ── Recording ──
      case MSG.START_RECORDING:
        await startRecording(payload.tabId);
        sendResponse({ ok: true });
        break;

      case MSG.STOP_RECORDING:
        await stopRecording(payload.name, sendResponse);
        break;

      case MSG.ABORT_RECORDING:
        await abortRecording();
        sendResponse({ ok: true });
        break;

      // ── Replay ──
      case MSG.RUN_RECORDING: {
        const recordings = await getRecordings();
        const rec = recordings.find(r => r.id === payload.recordingId);
        if (!rec) { sendResponse({ ok: false, error: 'Recording not found' }); break; }
        sendResponse({ ok: true });
        await runRecording(rec, payload.tabId);
        break;
      }

      case MSG.RUN_ALL: {
        sendResponse({ ok: true });
        await runAll(payload.tabId);
        break;
      }

      case MSG.ABORT_RUN:
        replayState.aborted = true;
        // Detach the debugger immediately so any in-flight CDP call throws right away,
        // terminating the current step without waiting for it to finish naturally.
        if (replayState.active && replayState.tabId) {
          chrome.debugger.detach({ tabId: replayState.tabId }).catch(() => {});
        }
        sendResponse({ ok: true });
        break;

      case MSG.RESET_STATE:
        // Force-clear all recording and replay state.
        // Called on sidepanel init and by the manual reset button.
        await forceReset();
        sendResponse({ ok: true });
        break;

      // ── Storage ──
      case MSG.GET_RECORDINGS: {
        const recordings = await getRecordings();
        sendResponse({ recordings });
        break;
      }

      case MSG.GET_HISTORY: {
        const history = await getRunHistory(payload?.recordingId ?? null);
        sendResponse({ history });
        break;
      }

      case MSG.DELETE_RECORDING:
        await deleteRecording(payload.recordingId);
        sendResponse({ ok: true });
        break;

      case MSG.DELETE_STEP: {
        const idx = payload.index;
        if (recordingState.active && idx >= 0 && idx < recordingState.steps.length) {
          recordingState.steps.splice(idx, 1);
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false });
        }
        break;
      }

      case MSG.UPDATE_RECORDING_STEP: {
        const { index, value } = payload;
        const step = recordingState.active && recordingState.steps[index];
        if (step && step.type === 'change') {
          step.value = value;
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false });
        }
        break;
      }

      case MSG.UPDATE_RECORDING: {
        const { id, title, steps, createdAt } = payload;
        const updated = await saveRecording({ id, title, steps, createdAt });
        sendResponse({ ok: true, recording: updated });
        break;
      }

      case MSG.ADD_RECORDING_STEP: {
        if (recordingState.active && payload.step) {
          const step = payload.step;

          // Auto-prepend a waitForElement for steps that target a specific element.
          if ((step.type === 'saveVariable' || step.type === 'pasteVariable') && step.selectors?.length) {
            const waitStep = {
              type: 'waitForElement',
              target: step.target ?? 'main',
              selectors: step.selectors,
              ...(step.frame?.length ? { frame: step.frame } : {}),
            };
            recordingState.steps.push(waitStep);
            broadcast(MSG.RECORD_STEP, { step: waitStep });
          }

          recordingState.steps.push(step);

          // For pasteVariable: also fill the target field immediately during recording
          // so the user gets visual feedback that the value was inserted.
          if (step.type === 'pasteVariable' && step.fallbackValue && step.selectors?.length) {
            chrome.scripting.executeScript({
              target: { tabId: recordingState.tabId },
              func: (selList, txt) => {
                let el = null;
                for (const s of selList) {
                  const sel = s[0];
                  if (!sel) continue;
                  try {
                    if (sel.startsWith('xpath/')) {
                      el = document.evaluate(sel.slice(6), document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                    } else if (!sel.startsWith('aria/') && !sel.startsWith('text/') && !sel.startsWith('pierce/')) {
                      el = document.querySelector(sel);
                    }
                    if (el) break;
                  } catch (_) {}
                }
                if (!el || !['INPUT', 'TEXTAREA'].includes(el.tagName)) return;
                el.focus();
                el.select?.();
                el.value = txt;
                el.dispatchEvent(new Event('input',  { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              },
              args: [step.selectors, step.fallbackValue],
            }).catch(() => {});
          }

          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false });
        }
        break;
      }

      // ── Called from content script during recording ──
      case MSG.STORE_CONTEXT_EL:
        // Content script sends the right-clicked element info here so the
        // context menu handler can use it without a fragile executeScript call.
        if (recordingState.active) lastContextMenuEl = payload;
        sendResponse({ ok: true }); // close the port immediately (fire-and-forget)
        break;

      case MSG.RECORD_STEP:
        if (recordingState.active && payload.step) {
          recordingState.steps.push(payload.step);
          console.log(`[Recorder] step ${recordingState.steps.length}:`, JSON.stringify(payload.step, null, 2));
          // No re-broadcast: sidepanel already receives this message directly from the content script.
          // (Hover steps created in the SW are broadcast separately via the context menu handler.)
        }
        sendResponse({ ok: true }); // close the port immediately (fire-and-forget)
        break;

      default:
        sendResponse({ ok: false, error: `Unknown message type: ${type}` });
    }
    } catch (err) {
      // Swallow "Cannot access a chrome-extension:// URL of different extension" and
      // any other errors thrown by sendResponse when the port is already closed.
      console.warn(`[SW] Error handling message "${type}":`, err.message);
      try { sendResponse({ ok: false, error: err.message }); } catch (_) {}
    }
  })();

  return true; // keep message channel open for async response
});

// ── Recording ──────────────────────────────────────────────────────────────────
async function startRecording(tabId) {
  // Always force-cleanup any previous recorder session first.
  // This resets window.__recorderActive so the re-injection guard doesn't block us.
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        window.__recorderCleanup?.();
        window.__recorderActive = false;
      },
    });
  } catch (_) { /* tab may not be ready yet, proceed anyway */ }

  // Record the current page as the first step so replay always begins on the right page.
  const tab = await chrome.tabs.get(tabId);
  const startUrl = tab.url ?? '';
  const firstStep = {
    type: 'navigate',
    url: startUrl,
    assertedEvents: [{ type: 'navigation', url: startUrl, title: '' }],
  };

  recordingState = { active: true, tabId, steps: [firstStep] };
  startKeepalive();
  broadcast(MSG.RECORD_STEP, { step: firstStep });

  // Inject recorder content script
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['content/recorder.js'],
  });

  // Also inject on future navigations within this tab
  chrome.webNavigation.onDOMContentLoaded.addListener(onNavCommitted);
}

async function onNavCommitted(details) {
  if (!recordingState.active || details.tabId !== recordingState.tabId) return;
  if (details.frameId !== 0) return; // only main-frame navigations

  // Skip internal browser URLs
  const url = details.url ?? '';
  if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('about:')) return;

  // Record a navigate step with the CORRECT destination URL
  // (details.url is where we're arriving, not where we came from)
  const step = {
    type: 'navigate',
    url,
    assertedEvents: [{ type: 'navigation', url, title: '' }],
  };
  recordingState.steps.push(step);
  broadcast(MSG.RECORD_STEP, { step });

  // Re-inject recorder into the new page
  try {
    await chrome.scripting.executeScript({
      target: { tabId: details.tabId, allFrames: true },
      files: ['content/recorder.js'],
    });
  } catch (err) {
    console.warn('[Recorder] Re-inject after nav failed:', err.message);
  }
}

async function stopRecording(name, sendResponse) {
  if (!recordingState.active) { sendResponse({ ok: false }); return; }

  recordingState.active = false;
  stopKeepalive();
  chrome.webNavigation.onDOMContentLoaded.removeListener(onNavCommitted);

  // Remove the recorder script from the tab by calling cleanup
  try {
    await chrome.scripting.executeScript({
      target: { tabId: recordingState.tabId, allFrames: true },
      func: () => { window.__recorderCleanup?.(); },
    });
  } catch (_) {}

  const id = crypto.randomUUID();
  const saved = await saveRecording({ id, title: name, steps: recordingState.steps });
  broadcast(MSG.RECORDING_STATE, { recording: false });
  sendResponse({ ok: true, recording: saved });
}

async function abortRecording() {
  recordingState.active = false;
  stopKeepalive();
  chrome.webNavigation.onDOMContentLoaded.removeListener(onNavCommitted);
  try {
    await chrome.scripting.executeScript({
      target: { tabId: recordingState.tabId, allFrames: true },
      func: () => { window.__recorderCleanup?.(); },
    });
  } catch (_) {}
}

async function forceReset() {
  // 1. Tear down any active recording
  if (recordingState.active) {
    recordingState.active = false;
    chrome.webNavigation.onDOMContentLoaded.removeListener(onNavCommitted);
    try {
      await chrome.scripting.executeScript({
        target: { tabId: recordingState.tabId, allFrames: true },
        func: () => { window.__recorderCleanup?.(); },
      });
    } catch (_) {}
  }
  recordingState = { active: false, tabId: null, steps: [] };

  // 2. Tear down any active replay
  if (replayState.active && replayState.tabId) {
    try { await chrome.debugger.detach({ tabId: replayState.tabId }); } catch (_) {}
  }
  replayState = { active: false, aborted: false, tabId: null, reattachPromise: null };

  // 3. Stop keepalive alarm
  stopKeepalive();

  // 4. Notify sidepanel so it resets its UI to idle
  broadcast(MSG.RECORDING_STATE, { recording: false });
}

// ── Replay ─────────────────────────────────────────────────────────────────────
async function runRecording(recording, tabId) {
  if (replayState.active) return; // prevent concurrent runs

  replayState = { active: true, aborted: false, tabId, reattachPromise: null };
  clipboardVars = new Map();
  variables = new Map();
  frameContextMap = new Map();

  startKeepalive();

  // Start every run from a blank page so there's no leftover state from a
  // previous session. The first recorded step (navigate) will go to the real URL.
  await chrome.tabs.update(tabId, { url: 'about:blank' });
  // Give the browser a moment to load blank before attaching the debugger.
  await new Promise(r => setTimeout(r, 300));

  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const stepResults = [];

  let attached = false;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    attached = true;

    // Enable CDP domains
    await cdp(tabId, 'Runtime.enable');
    await cdp(tabId, 'Page.enable');

    for (let i = 0; i < recording.steps.length; i++) {
      // If the debugger was detached by a cross-origin navigation, wait for
      // re-attachment to complete before running the next step.
      if (replayState.reattachPromise) {
        console.log(`[Replay] step ${i + 1} waiting for debugger re-attachment...`);
        await replayState.reattachPromise;
      }
      if (replayState.aborted) break;

      const step = recording.steps[i];
      const stepStart = Date.now();
      const stepDetail = getStepDetail(step);

      broadcast(MSG.STEP_PROGRESS, {
        stepIndex: i,
        total: recording.steps.length,
        status: 'running',
        stepType: step.type,
        stepDetail,
      });

      try {
        // Auto: waitForElement before clicks, change, and selectOption steps
        if ((step.type === 'click' || step.type === 'doubleClick' || step.type === 'change' || step.type === 'selectOption') && step.selectors?.length) {
          // Ensure any in-progress re-attachment is done before issuing CDP calls.
          if (replayState.reattachPromise) await replayState.reattachPromise;
          if (!replayState.aborted) {
            console.log(`[Replay] step ${i + 1} auto → waitForElement`, JSON.stringify(step.selectors));
            await executeStep(
              { type: 'waitForElement', selectors: step.selectors, target: step.target },
              tabId, frameContextMap, clipboardVars, cdp, variables
            ).catch(err => console.warn(`[Replay] step ${i + 1} waitForElement failed (proceeding):`, err.message));
          }
          // The debugger may have detached DURING the waitForElement (e.g. Salesforce SSO).
          // waitForSelector now fails fast on CDP errors, so this re-attach wait is short.
          // After re-attachment, re-run waitForElement so the element actually settles
          // on the freshly-loaded page before the click fires.
          if (replayState.reattachPromise) {
            console.log(`[Replay] step ${i + 1} waiting for re-attachment after waitForElement detach…`);
            await replayState.reattachPromise;
            if (replayState.aborted) break;
            console.log(`[Replay] step ${i + 1} re-running waitForElement after re-attach`);
            await executeStep(
              { type: 'waitForElement', selectors: step.selectors, target: step.target },
              tabId, frameContextMap, clipboardVars, cdp, variables
            ).catch(err => console.warn(`[Replay] step ${i + 1} waitForElement (post-reattach) failed (proceeding):`, err.message));
          }
        }

        if (replayState.aborted) break;
        console.log(`[Replay] step ${i + 1}:`, JSON.stringify(step, null, 2));
        await executeStep(step, tabId, frameContextMap, clipboardVars, cdp, variables);

        // Auto: waitForPageLoad after navigate or selectOption (which may trigger navigation)
        if ((step.type === 'navigate' || step.type === 'selectOption') && !replayState.aborted) {
          // Wait for any in-progress re-attachment (e.g. Salesforce SSO fires target_closed
          // asynchronously during or just after the navigate step) before issuing CDP calls.
          if (replayState.reattachPromise) await replayState.reattachPromise;
          if (!replayState.aborted) {
            console.log(`[Replay] step ${i + 1} auto → waitForPageLoad`);
            await executeStep(
              { type: 'waitForPageLoad' },
              tabId, frameContextMap, clipboardVars, cdp, variables
            ).catch(err => console.warn(`[Replay] step ${i + 1} waitForPageLoad failed (proceeding):`, err.message));
          }
        }

        await new Promise(r => setTimeout(r, 50)); // 50 ms gap between actions

        const durationMs = Date.now() - stepStart;
        stepResults.push({ index: i, type: step.type, status: 'passed', durationMs });

        broadcast(MSG.STEP_PROGRESS, {
          stepIndex: i,
          total: recording.steps.length,
          status: 'passed',
          stepType: step.type,
          stepDetail,
          durationMs,
        });
      } catch (err) {
        const durationMs = Date.now() - stepStart;
        const errorMsg = err.message ?? String(err);
        console.error(`[Replay] step ${i + 1} (${step.type}) FAILED:`, errorMsg, step);
        stepResults.push({ index: i, type: step.type, status: 'failed', durationMs, error: errorMsg });

        broadcast(MSG.STEP_PROGRESS, {
          stepIndex: i,
          total: recording.steps.length,
          status: 'failed',
          stepType: step.type,
          stepDetail,
          durationMs,
          error: errorMsg,
        });

        // Save result and exit
        const result = {
          runId,
          recordingId: recording.id,
          recordingTitle: recording.title,
          startedAt,
          completedAt: new Date().toISOString(),
          passed: false,
          totalSteps: recording.steps.length,
          completedSteps: i,
          failedStep: { index: i, type: step.type, error: errorMsg },
          stepResults,
        };
        await appendRunResult(result);

        broadcast(MSG.RUN_COMPLETE, {
          recordingId: recording.id,
          runId,
          passed: false,
          failedStep: result.failedStep,
        });

        return result;
      }
    }

    // All steps done (or aborted)
    const passed = !replayState.aborted;
    const result = {
      runId,
      recordingId: recording.id,
      recordingTitle: recording.title,
      startedAt,
      completedAt: new Date().toISOString(),
      passed,
      totalSteps: recording.steps.length,
      completedSteps: stepResults.filter(s => s.status === 'passed').length,
      failedStep: null,
      stepResults,
    };
    await appendRunResult(result);
    broadcast(MSG.RUN_COMPLETE, { recordingId: recording.id, runId, passed, failedStep: null });
    return result;

  } finally {
    if (attached) {
      try { await chrome.debugger.detach({ tabId }); } catch (_) {}
    }
    // Preserve `aborted` so runAll's outer loop can detect a mid-batch abort.
    // The next call to runRecording resets it to false at its own start.
    replayState.active = false;
    replayState.tabId = null;
    stopKeepalive();
  }
}

async function runAll(tabId) {
  const recordings = await getRecordings();
  if (recordings.length === 0) return;

  const results = [];

  for (let i = 0; i < recordings.length; i++) {
    if (replayState.aborted) break;

    broadcast(MSG.BATCH_PROGRESS, {
      current: i + 1,
      total: recordings.length,
      recordingTitle: recordings[i].title,
    });

    const result = await runRecording(recordings[i], tabId);
    results.push({ recordingId: recordings[i].id, title: recordings[i].title, passed: result?.passed ?? false });
  }

  broadcast(MSG.BATCH_COMPLETE, { results });
}

// ── Open side panel when extension icon is clicked ─────────────────────────────
chrome.action.onClicked.addListener(async tab => {
  await chrome.sidePanel.open({ tabId: tab.id });
});

// ── Context menu: "Record Hover" + "Wait for element" ─────────────────────────
// Create once on SW startup (removeAll first to avoid duplicates on reload)
chrome.contextMenus.removeAll(() => {
  chrome.contextMenus.create({
    id: 'record-hover',
    title: 'Record Hover',
    contexts: ['all'],
  });
  chrome.contextMenus.create({
    id: 'record-wait',
    title: 'Wait for element',
    contexts: ['all'],
  });
  chrome.contextMenus.create({
    id: 'record-variable',
    title: 'Save variable',
    contexts: ['all'],
  });
  chrome.contextMenus.create({
    id: 'record-paste-variable',
    title: 'Paste variable',
    contexts: ['all'],
  });
  chrome.contextMenus.create({
    id: 'record-wait-time',
    title: 'Wait for time',
    contexts: ['all'],
  });
});

chrome.contextMenus.onClicked.addListener((_info, tab) => {
  if (!recordingState.active || tab.id !== recordingState.tabId) return;
  if (!['record-hover', 'record-wait', 'record-variable', 'record-paste-variable', 'record-wait-time'].includes(_info.menuItemId)) return;

  // Wait-for-time doesn't need element info — handle it before the elInfo check.
  if (_info.menuItemId === 'record-wait-time') {
    broadcast(MSG.SHOW_WAIT_DIALOG, {});
    return;
  }

  // Use the element info stored by the content script via STORE_CONTEXT_EL message.
  const elInfo = lastContextMenuEl;
  if (!elInfo) return;
  lastContextMenuEl = null; // consume it

  if (_info.menuItemId === 'record-variable') {
    // Prompt the user for a variable name via the sidepanel dialog.
    // The step will be added to recordingState when the sidepanel responds
    // with ADD_RECORDING_STEP after the user confirms the dialog.
    broadcast(MSG.SHOW_VARIABLE_DIALOG, {
      selectors: elInfo.selectors,
      defaultValue: elInfo.elementValue ?? '',
      frame: elInfo.frame ?? [],
    });
    return;
  }

  if (_info.menuItemId === 'record-paste-variable') {
    // Collect saved variables with their defaultValues so the sidepanel can
    // both display them and embed a fallback value in the recorded step.
    const availableVars = recordingState.steps
      .filter(s => s.type === 'saveVariable')
      .map(s => ({ name: s.variableName, defaultValue: s.defaultValue ?? '' }));
    broadcast(MSG.SHOW_PASTE_VARIABLE_DIALOG, {
      selectors: elInfo.selectors,
      frame: elInfo.frame ?? [],
      variables: availableVars,
    });
    return;
  }

  let step;
  if (_info.menuItemId === 'record-hover') {
    step = {
      type: 'hover',
      target: 'main',
      selectors: elInfo.selectors,
      offsetX: elInfo.offsetX,
      offsetY: elInfo.offsetY,
      ...(elInfo.frame?.length ? { frame: elInfo.frame } : {}),
    };
  } else {
    step = {
      type: 'waitForElement',
      target: 'main',
      selectors: elInfo.selectors,
      ...(elInfo.frame?.length ? { frame: elInfo.frame } : {}),
    };
  }

  recordingState.steps.push(step);
  broadcast(MSG.RECORD_STEP, { step });
});
