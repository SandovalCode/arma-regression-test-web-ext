import { resolveSelector } from "../selector-resolver.js";
import { NAV_TIMEOUT_MS } from "../constants.js";
import {
  resolveObjectId,
  dispatchMouse,
  scrollIntoViewAndGetRect,
  sleep,
  waitForNavigation
} from "./helpers.js";

// ── click ──────────────────────────────────────────────────────────────────────

export async function execClick(step, tabId, contextId, cdp) {
  // Resolve objectId first so we can scroll into view before clicking (Playwright approach).
  // Input.dispatchMouseEvent expects viewport-relative coordinates. Scrolling the element
  // into view guarantees getBoundingClientRect() returns usable viewport coords.
  const objectId = await resolveObjectId(step.selectors, tabId, contextId, cdp);

  let cx, cy;
  if (objectId) {
    const box = await scrollIntoViewAndGetRect(objectId, tabId, cdp);
    if (box) {
      cx = box.x + (step.offsetX ?? 0);
      cy = box.y + (step.offsetY ?? 0);
    }
  }
  if (cx == null) {
    const { x, y } = await resolveSelector(
      step.selectors,
      tabId,
      contextId,
      cdp
    );
    cx = x + (step.offsetX ?? 0);
    cy = y + (step.offsetY ?? 0);
  }

  const hasNav = step.assertedEvents?.some((e) => e.type === "navigation");
  const navPromise = hasNav ? waitForNavigation(tabId, NAV_TIMEOUT_MS) : null;

  // mouseMoved triggers mouseenter on the element and all its ancestors (CDP real event).
  await dispatchMouse(tabId, "mouseMoved", cx, cy, "none", 0, cdp);

  // Wait for mouseenter handlers to finish before clicking.
  // Frameworks like Salesforce Aura/LWC activate/show controls in response to
  // mouseenter, and the click must arrive after that handler completes.
  await sleep(80);

  // Blur the previously focused element before clicking the new one — mirrors real
  // browser behaviour and prevents Salesforce from setting aria-hidden on a panel
  // while its search input still has focus (which triggers the O11Y error dialog).
  // EXCEPTION: if the click target is inside a search dropdown/listbox, skipping
  // blur is critical — blurring the search bar dismisses the dropdown and removes
  // the target element from the DOM before mousePressed can land on it.
  const insideSearchPanel = objectId
    ? await cdp(tabId, "Runtime.callFunctionOn", {
        objectId,
        functionDeclaration:
          'function() { return !!this.closest(\'[role="listbox"], [role="option"], .assistantPanel, .instant-result-item, [id^="suggestionsList"]\'); }',
        returnByValue: true
      })
        .then((r) => !!r?.result?.value)
        .catch(() => false)
    : false;

  if (!insideSearchPanel) {
    await cdp(tabId, "Runtime.evaluate", {
      expression:
        "document.activeElement && document.activeElement !== document.body ? document.activeElement.blur() : undefined",
      returnByValue: true
    }).catch(console.error);
  }

  if (objectId) {
    await cdp(tabId, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: "function() { this.focus(); }",
      returnByValue: true
    }).catch(console.error);
  }

  await dispatchMouse(tabId, "mousePressed", cx, cy, "left", 1, cdp);
  if (step.duration) await sleep(step.duration);
  await dispatchMouse(tabId, "mouseReleased", cx, cy, "left", 1, cdp);

  // Belt-and-suspenders: fire synthetic JS events on the element so that
  // Salesforce LWC (and other frameworks) patched event handlers also fire.
  // NOTE: 'click' is intentionally excluded — CDP mousePressed+mouseReleased already
  // fires a real browser click event. A second synthetic click would toggle any
  // dropdown/toggle button closed immediately after it opens.
  if (objectId) {
    await cdp(tabId, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function() {
        const cx = ${cx}, cy = ${cy};
        ['mouseenter', 'mouseover', 'mousedown', 'mouseup'].forEach(type => {
          this.dispatchEvent(new MouseEvent(type, {
            view: window, bubbles: true, cancelable: true,
            clientX: cx, clientY: cy,
          }));
        });
      }`,
      returnByValue: true
    }).catch(console.error);
  }

  if (navPromise) {
    await navPromise;
    await sleep(300);
  }
}

// ── doubleClick ────────────────────────────────────────────────────────────────

export async function execDoubleClick(step, tabId, contextId, cdp) {
  const objectId = await resolveObjectId(step.selectors, tabId, contextId, cdp);
  let cx, cy;
  if (objectId) {
    const box = await scrollIntoViewAndGetRect(objectId, tabId, cdp);
    if (box) {
      cx = box.x + (step.offsetX ?? 0);
      cy = box.y + (step.offsetY ?? 0);
    }
  }
  if (cx == null) {
    const { x, y } = await resolveSelector(
      step.selectors,
      tabId,
      contextId,
      cdp
    );
    cx = x + (step.offsetX ?? 0);
    cy = y + (step.offsetY ?? 0);
  }

  await dispatchMouse(tabId, "mouseMoved", cx, cy, "none", 0, cdp);
  await dispatchMouse(tabId, "mousePressed", cx, cy, "left", 1, cdp);
  await dispatchMouse(tabId, "mouseReleased", cx, cy, "left", 1, cdp);
  await dispatchMouse(tabId, "mousePressed", cx, cy, "left", 2, cdp);
  await dispatchMouse(tabId, "mouseReleased", cx, cy, "left", 2, cdp);
}

// ── hover ──────────────────────────────────────────────────────────────────────

export async function execHover(step, tabId, contextId, cdp) {
  const objectId = await resolveObjectId(step.selectors, tabId, contextId, cdp);
  let cx, cy;
  if (objectId) {
    const box = await scrollIntoViewAndGetRect(objectId, tabId, cdp);
    if (box) {
      cx = box.x + (step.offsetX ?? 0);
      cy = box.y + (step.offsetY ?? 0);
    }
  }
  if (cx == null) {
    const { x, y } = await resolveSelector(
      step.selectors,
      tabId,
      contextId,
      cdp
    );
    cx = x + (step.offsetX ?? 0);
    cy = y + (step.offsetY ?? 0);
  }
  await dispatchMouse(tabId, "mouseMoved", cx, cy, "none", 0, cdp);
}
