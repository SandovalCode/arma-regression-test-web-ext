import { execSetViewport } from "./viewport.js";
import { execNavigate } from "./navigate.js";
import { execClick, execDoubleClick, execHover } from "./mouse.js";
import { execChange, execSelectOption } from "./input.js";
import { execKeyDown, execKeyUp } from "./keyboard.js";
import { execWaitForElement, execWaitForElementWithRefresh, execWaitForPageLoad, execWaitForMutation } from "./wait.js";
import { execScroll } from "./scroll.js";
import { STEP_TIMEOUT_MS } from "../constants.js";
import {
  execCopyVariableAtRecording,
  execPasteVariableAtRecording,
  execCopyVariableAtReplaying,
  execPasteVariableAtReplaying
} from "./clipboard.js";
import { sleep } from "./helpers.js";
import { execAssertElement, execAssertNotPresent } from "./assert.js";

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
  const { contextId, iframeOffset } = await resolveContext(step, frameContextMap, tabId, cdp);

  switch (step.type) {
    case "setViewport":
      return execSetViewport(step, tabId, cdp);
    case "navigate":
      return execNavigate(step, tabId, cdp);
    case "click":
      return execClick(step, tabId, contextId, cdp, iframeOffset);
    case "doubleClick":
      return execDoubleClick(step, tabId, contextId, cdp, iframeOffset);
    case "hover":
      return execHover(step, tabId, contextId, cdp, iframeOffset);
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
    case "waitForElementWithRefresh":
      return execWaitForElementWithRefresh(step, tabId, contextId, cdp);
    case "waitForPageLoad":
      return execWaitForPageLoad(tabId, cdp);
    case "waitForMutation":
      return execWaitForMutation(step, tabId, contextId, cdp);
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
    case "assertElement":
      return execAssertElement(step, tabId, contextId, cdp);
    case "assertNotPresent":
      return execAssertNotPresent(step, tabId, contextId, cdp);
    default:
      // Unknown step types are silently skipped so new recorder formats don't crash
      console.warn(
        `[step-executor] Unknown step type: ${step.type} — skipping`
      );
  }
}

// ── Context resolution ─────────────────────────────────────────────────────────

// Resolves step.frame (array of integer indices, e.g. [0] = first child iframe)
// to a CDP executionContextId and the iframe's {x, y} offset in the main viewport.
//
// The offset is needed because getBoundingClientRect() inside an iframe returns
// coordinates relative to the iframe's own viewport origin, but Input.dispatchMouseEvent
// expects coordinates relative to the main page's viewport. Adding the iframe's
// top-left position (from the <iframe> element's getBoundingClientRect in the main frame)
// converts iframe-relative coords to main-page-relative coords.
async function resolveContext(step, frameContextMap, tabId, cdp) {
  if (!step.frame || step.frame.length === 0) {
    return { contextId: null, iframeOffset: null };
  }

  try {
    // SPA pages (e.g. split-view panels) create iframes dynamically after navigation.
    // Poll Page.getFrameTree until the target frame index exists, up to STEP_TIMEOUT_MS.
    const frameDeadline = Date.now() + STEP_TIMEOUT_MS;
    let node = null;
    while (Date.now() < frameDeadline) {
      const { frameTree } = await cdp(tabId, "Page.getFrameTree");
      let current = frameTree;
      let found = true;
      for (const idx of step.frame) {
        const children = current.childFrames ?? [];
        if (idx >= children.length) { found = false; break; }
        current = children[idx];
      }
      if (found) { node = current; break; }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!node) return { contextId: null, iframeOffset: null };

    const frameId = node.frame.id;

    // Runtime.executionContextCreated events arrive asynchronously after Runtime.enable.
    // Wait up to 2s for the iframe's execution context to appear.
    const deadline = Date.now() + 2000;
    while (!frameContextMap.has(frameId) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }

    const contextId = frameContextMap.get(frameId) ?? null;

    // Resolve the <iframe> element's position in the main page viewport.
    // DOM.getFrameOwner returns the nodeId of the <iframe> element in the parent document.
    let iframeOffset = null;
    try {
      const { nodeId } = await cdp(tabId, "DOM.getFrameOwner", { frameId });
      if (nodeId) {
        const { object } = await cdp(tabId, "DOM.resolveNode", { nodeId });
        if (object?.objectId) {
          const res = await cdp(tabId, "Runtime.callFunctionOn", {
            objectId: object.objectId,
            functionDeclaration:
              "function() { const r = this.getBoundingClientRect(); return { x: r.left, y: r.top }; }",
            returnByValue: true
          });
          if (res?.result?.value) iframeOffset = res.result.value;
        }
      }
    } catch (_) {
      // DOM.getFrameOwner may fail for detached frames — safe to ignore
    }

    return { contextId, iframeOffset };
  } catch (_) {
    return { contextId: null, iframeOffset: null };
  }
}
