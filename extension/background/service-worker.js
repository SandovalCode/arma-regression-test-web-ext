import { MSG, RecordingState, KEEPALIVE_MINS, MAX_HISTORY_ENTRIES } from '../shared/constants.js';
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

// Execution context map: frameId → executionContextId (populated via Runtime events)
let frameContextMap = new Map();

// ── CDP helper ─────────────────────────────────────────────────────────────────
function cdp(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

// ── Broadcast to all extension views ──────────────────────────────────────────
function broadcast(type, payload = {}) {
  chrome.runtime.sendMessage({ type, payload }).catch(() => {});
}

// ── Debugger event listener ────────────────────────────────────────────────────
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method === 'Runtime.executionContextCreated') {
    const ctx = params.context;
    if (ctx.auxData?.frameId) {
      frameContextMap.set(ctx.auxData.frameId, ctx.id);
    }
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
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

      // ── Called from content script during recording ──
      case MSG.RECORD_STEP:
        if (recordingState.active && payload.step) {
          recordingState.steps.push(payload.step);
          broadcast(MSG.RECORD_STEP, { step: payload.step });
        }
        break;

      default:
        sendResponse({ ok: false, error: `Unknown message type: ${type}` });
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

  recordingState = { active: true, tabId, steps: [] };

  // Inject recorder content script
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['content/recorder.js'],
  });

  // Also inject on future navigations within this tab
  chrome.webNavigation?.onCommitted?.addListener(onNavCommitted);
}

async function onNavCommitted(details) {
  if (!recordingState.active || details.tabId !== recordingState.tabId) return;
  // Re-inject recorder after navigation
  try {
    await chrome.scripting.executeScript({
      target: { tabId: details.tabId, frameId: details.frameId, allFrames: false },
      files: ['content/recorder.js'],
    });
  } catch (_) { /* frame may not be ready yet */ }
}

async function stopRecording(name, sendResponse) {
  if (!recordingState.active) { sendResponse({ ok: false }); return; }

  recordingState.active = false;
  chrome.webNavigation?.onCommitted?.removeListener(onNavCommitted);

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
  chrome.webNavigation?.onCommitted?.removeListener(onNavCommitted);
  try {
    await chrome.scripting.executeScript({
      target: { tabId: recordingState.tabId, allFrames: true },
      func: () => { window.__recorderCleanup?.(); },
    });
  } catch (_) {}
}

// ── Replay ─────────────────────────────────────────────────────────────────────
async function runRecording(recording, tabId) {
  if (replayState.active) return; // prevent concurrent runs

  replayState = { active: true, aborted: false, tabId };
  clipboardVars = new Map();
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

      broadcast(MSG.STEP_PROGRESS, {
        stepIndex: i,
        total: recording.steps.length,
        status: 'running',
        stepType: step.type,
      });

      try {
        await executeStep(step, tabId, frameContextMap, clipboardVars, cdp);

        const durationMs = Date.now() - stepStart;
        stepResults.push({ index: i, type: step.type, status: 'passed', durationMs });

        broadcast(MSG.STEP_PROGRESS, {
          stepIndex: i,
          total: recording.steps.length,
          status: 'passed',
          stepType: step.type,
          durationMs,
        });
      } catch (err) {
        const durationMs = Date.now() - stepStart;
        const errorMsg = err.message ?? String(err);
        stepResults.push({ index: i, type: step.type, status: 'failed', durationMs, error: errorMsg });

        broadcast(MSG.STEP_PROGRESS, {
          stepIndex: i,
          total: recording.steps.length,
          status: 'failed',
          stepType: step.type,
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
    replayState = { active: false, aborted: false, tabId: null };
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

// ── Context menu: "Registrar Hover" ───────────────────────────────────────────
// Create once on SW startup (removeAll first to avoid duplicates on reload)
chrome.contextMenus.removeAll(() => {
  chrome.contextMenus.create({
    id: 'record-hover',
    title: 'Registrar Hover',
    contexts: ['all'],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'record-hover') return;
  if (!recordingState.active || tab.id !== recordingState.tabId) return;

  // Ask the content script for the element that was right-clicked
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameId: info.frameId },
      func: () => window.__lastContextMenuEl ?? null,
    });
  } catch (_) { return; }

  const elInfo = results?.[0]?.result;
  if (!elInfo) return;

  const step = {
    type: 'hover',
    target: 'main',
    selectors: elInfo.selectors,
    offsetX: elInfo.offsetX,
    offsetY: elInfo.offsetY,
    ...(elInfo.frame?.length ? { frame: elInfo.frame } : {}),
  };

  recordingState.steps.push(step);
  broadcast(MSG.RECORD_STEP, { step });
});
