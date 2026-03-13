import { MSG } from "../shared/constants.js";
import {
  getRecordings,
  getRunHistory,
  deleteRecording,
  saveRecording
} from "../shared/storage.js";
import {
  recordingState,
  replayState,
  contextMenu,
  recordingVarSnapshots
} from "./state.js";
import { broadcast } from "./utils.js";
import {
  startRecording,
  continueRecording,
  stopRecording,
  abortRecording,
  forceReset
} from "./recording.js";
import { runRecording, runAll } from "./replay.js";

// ── Variable substitution helpers (recording time) ─────────────────────────────

// Removes text/ selectors whose content contains a known variable value.
// These selectors embed a dynamic value (e.g. a job ID) that would break
// replays when the value changes. Removing them lets the step fall back to
// stable structural selectors (aria, CSS, xpath).
function filterVarSelectorsOut(selectors, snapshots) {
  if (!Array.isArray(selectors)) return selectors;
  return selectors
    .map((group) =>
      group.filter((sel) => {
        if (typeof sel !== "string" || !sel.startsWith("text/")) return true;
        const text = sel.slice(5);
        for (const [, snapshot] of snapshots) {
          if (snapshot && snapshot.length >= 4 && text.includes(snapshot))
            return false;
        }
        return true;
      })
    )
    .filter((group) => group.length > 0); // drop groups that became empty
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

        case MSG.CONTINUE_RECORDING:
          await continueRecording(payload.tabId, payload.steps, payload.remainingSteps ?? []);
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
          const rec = recordings.find((r) => r.id === payload.recordingId);
          if (!rec) {
            sendResponse({ ok: false, error: "Recording not found" });
            break;
          }
          sendResponse({ ok: true });
          await runRecording(rec, payload.tabId, payload.stepDelay);
          break;
        }

        case MSG.RUN_ALL: {
          sendResponse({ ok: true });
          await runAll(payload.tabId, payload.stepDelay);
          break;
        }

        case MSG.DEBUG_NEXT:
          replayState.stepOnce = true; // pause again after the very next step
          if (replayState.debugResolve) {
            replayState.debugResolve();
            replayState.debugResolve = null;
          }
          sendResponse({ ok: true });
          break;

        case MSG.SET_DYNAMIC_BREAKPOINT:
          replayState.dynamicBreakpoints.add(payload.stepIndex);
          sendResponse({ ok: true });
          break;

        case MSG.DEBUG_FINISH:
          replayState.debugFinished = true;
          if (replayState.debugResolve) {
            replayState.debugResolve();
            replayState.debugResolve = null;
          }
          sendResponse({ ok: true });
          break;

        case MSG.ABORT_RUN:
          replayState.aborted = true;
          // If paused at a debug step, unblock the replay loop so it can detect abort.
          if (replayState.debugResolve) {
            replayState.debugResolve();
            replayState.debugResolve = null;
          }
          // Detach the debugger immediately so any in-flight CDP call throws right away,
          // terminating the current step without waiting for it to finish naturally.
          if (replayState.active && replayState.tabId) {
            chrome.debugger
              .detach({ tabId: replayState.tabId })
              .catch(console.error);
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
          if (
            recordingState.active &&
            idx >= 0 &&
            idx < recordingState.steps.length
          ) {
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
          if (step && step.type === "change") {
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

            // Track copyVariable snapshots for text/ selector filtering on subsequent steps.
            // defaultValue/fallbackValue are kept in the step only for recording-time visual
            // feedback — they are volatile and NEVER used as fallbacks at replay time.
            if (
              step.type === "copyVariable" &&
              step.variableName &&
              step.defaultValue
            ) {
              recordingVarSnapshots.set(step.variableName, step.defaultValue);
            }

            // Auto-prepend a waitForElement for steps that target a specific element.
            if (
              (step.type === "copyVariable" || step.type === "pasteVariable") &&
              step.selectors?.length
            ) {
              const waitStep = {
                type: "waitForElement",
                target: step.target ?? "main",
                selectors: step.selectors,
                ...(step.frame?.length ? { frame: step.frame } : {})
              };
              recordingState.steps.push(waitStep);
              broadcast(MSG.RECORD_STEP, { step: waitStep });
            }

            recordingState.steps.push(step);

            // For pasteVariable: fill the target field with the recording-time value so the
            // user gets visual feedback during recording. At replay time the live value is used.
            if (
              step.type === "pasteVariable" &&
              step.fallbackValue &&
              step.selectors?.length
            ) {
              chrome.scripting
                .executeScript({
                  target: { tabId: recordingState.tabId },
                  func: (selList, txt) => {
                    let el = null;
                    for (const s of selList) {
                      const sel = s[0];
                      if (!sel) continue;
                      try {
                        if (sel.startsWith("xpath/")) {
                          el = document.evaluate(
                            sel.slice(6),
                            document,
                            null,
                            XPathResult.FIRST_ORDERED_NODE_TYPE,
                            null
                          ).singleNodeValue;
                        } else if (
                          !sel.startsWith("aria/") &&
                          !sel.startsWith("text/") &&
                          !sel.startsWith("pierce/")
                        ) {
                          el = document.querySelector(sel);
                        }
                        if (el) break;
                      } catch (e) {
                        console.error(e);
                      }
                    }
                    if (!el || !["INPUT", "TEXTAREA"].includes(el.tagName))
                      return;
                    el.focus();
                    el.select?.();
                    el.value = txt;
                    el.dispatchEvent(new Event("input", { bubbles: true }));
                    el.dispatchEvent(new Event("change", { bubbles: true }));
                  },
                  args: [step.selectors, step.fallbackValue]
                })
                .catch(console.error);
            }

            sendResponse({ ok: true });
          } else {
            sendResponse({ ok: false });
          }
          break;
        }

        // ── Called from content script during recording ──
        case MSG.STORE_CONTEXT_EL:
          // Always store the right-clicked element — both for active recordings and
          // for "Add absence check" which is available outside of recording mode.
          contextMenu.lastEl = payload;
          chrome.storage.session
            .set({ lastContextMenuEl: payload })
            .catch(console.error);
          sendResponse({ ok: true }); // close the port immediately (fire-and-forget)
          break;

        case MSG.RECORD_STEP:
          if (recordingState.active && payload.step) {
            const step = { ...payload.step };

            // Track copy snapshots so later steps can reference them as {{varName}}
            if (
              step.type === "copy" &&
              step.variableName &&
              step.snapshotValue
            ) {
              recordingVarSnapshots.set(step.variableName, step.snapshotValue);
            }

            // Remove text/ selectors that contain a known variable value —
            // they embed a hardcoded dynamic value that breaks replays when it changes.
            if (step.selectors) {
              step.selectors = filterVarSelectorsOut(
                step.selectors,
                recordingVarSnapshots
              );
            }

            recordingState.steps.push(step);
            console.log(
              `[Recorder] step ${recordingState.steps.length}:`,
              JSON.stringify(step, null, 2)
            );
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
      try {
        sendResponse({ ok: false, error: err.message });
      } catch (e) {
        console.error(e);
      }
    }
  })();

  return true; // keep message channel open for async response
});
