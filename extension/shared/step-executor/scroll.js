import { resolveSelector } from "../selector-resolver.js";
import { dispatchMouse } from "./helpers.js";

// ── scroll ─────────────────────────────────────────────────────────────────────

export async function execScroll(step, tabId, contextId, cdp) {
  if (step.selectors?.length) {
    try {
      const { x, y } = await resolveSelector(
        step.selectors,
        tabId,
        contextId,
        cdp
      );
      await dispatchMouse(tabId, "mouseWheel", x, y, "none", 0, cdp, {
        deltaX: step.x ?? 0,
        deltaY: step.y ?? 0
      });
      return;
    } catch (e) {
      console.error(e);
    }
  }
  await cdp(tabId, "Runtime.evaluate", {
    expression: `window.scrollBy(${step.x ?? 0}, ${step.y ?? 0})`
  });
}
