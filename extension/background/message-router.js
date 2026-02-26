import { MSG } from '../shared/constants.js';
import { getRecordings, getRunHistory, deleteRecording, saveRecording } from '../shared/storage.js';
import { recordingState, replayState, contextMenu } from './state.js';
import { broadcast } from './utils.js';
import { startRecording, stopRecording, abortRecording, forceReset } from './recording.js';
import { runRecording, runAll } from './replay.js';

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
        // Also persisted to session storage so it survives a SW restart between
        // the right-click and the moment the user selects a context menu item.
        if (recordingState.active) {
          contextMenu.lastEl = payload;
          chrome.storage.session.set({ lastContextMenuEl: payload }).catch(() => {});
        }
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
