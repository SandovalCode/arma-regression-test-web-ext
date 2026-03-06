import { execSetViewport } from "./viewport.js";
import { execNavigate } from "./navigate.js";
import { execClick, execDoubleClick, execHover } from "./mouse.js";
import { execChange, execSelectOption } from "./input.js";
import { execKeyDown, execKeyUp } from "./keyboard.js";
import { execWaitForElement, execWaitForPageLoad } from "./wait.js";
import { execScroll } from "./scroll.js";
import {
  execCopyVariableAtRecording,
  execPasteVariableAtRecording,
  execCopyVariableAtReplaying,
  execPasteVariableAtReplaying
} from "./clipboard.js";
import { sleep } from "./helpers.js";

/**
 * Execute a single recording step using the Chrome DevTools Protocol.
 *
 * @param {object}  step            — The step object from the recording
 * @param {number}  tabId           — Chrome tab ID to execute against
 * @param {Map}     frameContextMap — Map<frameId, executionContextId>
 * @param {Map}     clipboardVars   — Map<variableName, copiedText> (persists during run)
 * @param {function} cdp            — cdp(tabId, method, params) helper from service worker
 * @param {Map}     variables       — Map<variableName, value> for user-defined saved variables
 */
export async function executeStep(
  step,
  tabId,
  frameContextMap,
  clipboardVars,
  cdp,
  variables = new Map()
) {
  const contextId = resolveContext(step, frameContextMap);

  switch (step.type) {
    case "setViewport":
      return execSetViewport(step, tabId, cdp);
    case "navigate":
      return execNavigate(step, tabId, cdp);
    case "click":
      return execClick(step, tabId, contextId, cdp);
    case "doubleClick":
      return execDoubleClick(step, tabId, contextId, cdp);
    case "hover":
      return execHover(step, tabId, contextId, cdp);
    case "change":
      return execChange(step, tabId, contextId, cdp);
    case "selectOption":
      return execSelectOption(step, tabId, contextId, cdp);
    case "keyDown":
      return execKeyDown(step, tabId, cdp);
    case "keyUp":
      return execKeyUp(step, tabId, cdp);
    case "waitForElement":
      return execWaitForElement(step, tabId, contextId, cdp);
    case "waitForPageLoad":
      return execWaitForPageLoad(tabId, cdp);
    case "scroll":
      return execScroll(step, tabId, contextId, cdp);
    case "copy":
      return execCopyVariableAtRecording(
        step,
        tabId,
        contextId,
        clipboardVars,
        cdp
      );
    case "paste":
      return execPasteVariableAtRecording(
        step,
        tabId,
        contextId,
        clipboardVars,
        cdp
      );
    case "copyVariable":
      return execCopyVariableAtReplaying(
        step,
        tabId,
        contextId,
        cdp,
        variables
      );
    case "pasteVariable":
      return execPasteVariableAtReplaying(
        step,
        tabId,
        contextId,
        cdp,
        variables
      );
    case "wait":
      return sleep(Math.max(0, step.duration ?? 0));
    default:
      // Unknown step types are silently skipped so new recorder formats don't crash
      console.warn(
        `[step-executor] Unknown step type: ${step.type} — skipping`
      );
  }
}

// ── Context resolution ─────────────────────────────────────────────────────────

function resolveContext(step, _frameContextMap) {
  if (!step.frame || step.frame.length === 0) return null;
  // TODO: full iframe support via Page.getFrameTree lookup.
  return null;
}
