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
    case 'change':      return `${sel}${step.label !== undefined ? ` → "${step.label}"` : step.value ? ` → "${step.value}"` : ''}`;
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

chrome.debugger.onDetach.addListener((source, _reason) => {
  if (source.tabId === replayState.tabId) {
    replayState.aborted = true;
  }
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

  // Record the starting URL as the first step so replay always begins on the right page
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
  replayState = { active: false, aborted: false, tabId: null };

  // 3. Stop keepalive alarm
  stopKeepalive();

  // 4. Notify sidepanel so it resets its UI to idle
  broadcast(MSG.RECORDING_STATE, { recording: false });
}

// ── Replay ─────────────────────────────────────────────────────────────────────
async function runRecording(recording, tabId) {
  if (replayState.active) return; // prevent concurrent runs

  replayState = { active: true, aborted: false, tabId };
  clipboardVars = new Map();
  variables = new Map();
  frameContextMap = new Map();

  startKeepalive();

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
        // Auto: waitForElement before clicks and change steps so the element is ready
        if ((step.type === 'click' || step.type === 'doubleClick' || step.type === 'change') && step.selectors?.length) {
          console.log(`[Replay] step ${i + 1} auto → waitForElement`, JSON.stringify(step.selectors));
          await executeStep(
            { type: 'waitForElement', selectors: step.selectors, target: step.target },
            tabId, frameContextMap, clipboardVars, cdp, variables
          ).catch(err => console.warn(`[Replay] step ${i + 1} waitForElement failed (proceeding):`, err.message));
        }

        console.log(`[Replay] step ${i + 1}:`, JSON.stringify(step, null, 2));
        await executeStep(step, tabId, frameContextMap, clipboardVars, cdp, variables);

        // Auto: waitForPageLoad after navigate so the next action waits for the page
        if (step.type === 'navigate' && !replayState.aborted) {
          console.log(`[Replay] step ${i + 1} auto → waitForPageLoad`);
          await executeStep(
            { type: 'waitForPageLoad' },
            tabId, frameContextMap, clipboardVars, cdp, variables
          ).catch(err => console.warn(`[Replay] step ${i + 1} waitForPageLoad failed (proceeding):`, err.message));
        }

        await new Promise(r => setTimeout(r, 400)); // 400 ms gap between actions

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
