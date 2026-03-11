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

export async function execClick(step, tabId, contextId, cdp, iframeOffset = null) {
  // Resolve objectId first so we can scroll into view before clicking (Playwright approach).
  // Input.dispatchMouseEvent expects viewport-relative coordinates. Scrolling the element
  // into view guarantees getBoundingClientRect() returns usable viewport coords.
  const objectId = await resolveObjectId(step.selectors, tabId, contextId, cdp);

  // iframeOffset: when the element is inside an iframe, getBoundingClientRect() returns
  // coordinates relative to the iframe's own viewport. Input.dispatchMouseEvent needs
  // main-page viewport coordinates, so we add the iframe's position in the main page.
  const ox = iframeOffset?.x ?? 0;
  const oy = iframeOffset?.y ?? 0;

  let cx, cy;
  if (objectId) {
    const box = await scrollIntoViewAndGetRect(objectId, tabId, cdp);
    if (box) {
      cx = box.x + (step.offsetX ?? 0) + ox;
      cy = box.y + (step.offsetY ?? 0) + oy;
    }
  }
  if (cx == null) {
    const { x, y } = await resolveSelector(
      step.selectors,
      tabId,
      contextId,
      cdp
    );
    cx = x + (step.offsetX ?? 0) + ox;
    cy = y + (step.offsetY ?? 0) + oy;
  }

  const hasNav = step.assertedEvents?.some((e) => e.type === "navigation");
  const navPromise = hasNav ? waitForNavigation(tabId, NAV_TIMEOUT_MS) : null;

  // mouseMoved triggers mouseenter on the element and all its ancestors (CDP real event).
  await dispatchMouse(tabId, "mouseMoved", cx, cy, "none", 0, cdp);

  // Wait for mouseenter handlers to finish before clicking.
  // Frameworks like Salesforce Aura/LWC activate/show controls in response to
  // mouseenter, and the click must arrive after that handler completes.
  await sleep(80);

  // Skip blur when blurring the active element would cause a side-effect that removes
  // or resets the click target before mousePressed lands.  Two cases:
  //   1. Explicit ARIA / search-panel containers (original guard).
  //   2. Heuristic: the button and document.activeElement share a common ancestor that
  //      is fixed/absolute-positioned (overlay, panel, drawer) — blurring inside such a
  //      container often triggers a focusout handler that dismisses it.
  const shouldSkipBlur = objectId
    ? await cdp(tabId, "Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function() {
          const el = this;
          // Case 1 — explicit ARIA / Salesforce search-panel selectors
          if (el.closest('[role="listbox"],[role="option"],.assistantPanel,.instant-result-item,[id^="suggestionsList"],dialog,[role="dialog"],[aria-modal="true"]')) return true;
          // Case 2 — shared overlay ancestor heuristic
          const active = document.activeElement;
          if (!active || active === document.body || active === document.documentElement || !el.contains || el === active) return false;
          let node = el.parentElement;
          while (node && node !== document.body) {
            if (node.contains(active)) {
              const pos = window.getComputedStyle(node).position;
              if (pos === 'fixed' || pos === 'absolute') return true;
            }
            node = node.parentElement;
          }
          return false;
        }`,
        returnByValue: true
      })
        .then((r) => !!r?.result?.value)
        .catch(() => false)
    : false;

  if (objectId) {
    // Blur the previously focused element and focus the target in a single synchronous
    // CDP call so the browser issues one coherent focus transition:
    //   focusout(relatedTarget=button) → focusin(button)
    // Doing these in two separate CDP calls leaves a gap where focus is nowhere,
    // which causes framework focusout handlers to see relatedTarget=null and
    // dismiss the panel/modal before mousePressed can land on the button.
    await cdp(tabId, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function() {
        if (!${shouldSkipBlur}) {
          const active = document.activeElement;
          if (active && active !== document.body && active !== this) active.blur();
        }
        this.focus();
      }`,
      returnByValue: true
    }).catch(console.error);
  } else if (!shouldSkipBlur) {
    await cdp(tabId, "Runtime.evaluate", {
      expression:
        "document.activeElement && document.activeElement !== document.body ? document.activeElement.blur() : undefined",
      returnByValue: true
    }).catch(console.error);
  }

  await dispatchMouse(tabId, "mousePressed", cx, cy, "left", 1, cdp);
  if (step.duration) await sleep(step.duration);
  await dispatchMouse(tabId, "mouseReleased", cx, cy, "left", 1, cdp);

  // Belt-and-suspenders: fire synthetic JS events on the element so that
  // Salesforce LWC (and other frameworks) patched event handlers also fire.
  // Also dispatch a synthetic 'click' for non-toggle buttons: CDP's mouseReleased
  // should auto-generate a native click, but when the element has pointer-events:none
  // children, focus transitions, or other interferences, that chain can break.
  // Guard: skip the synthetic click for toggle/dropdown buttons (aria-expanded,
  // aria-pressed, aria-haspopup) to avoid toggling them closed immediately.
  if (objectId) {
    // Synthetic events fire on the element in its own execution context (the iframe).
    // clientX/clientY must be iframe-viewport-relative (i.e. without the iframeOffset).
    const elemCx = cx - ox;
    const elemCy = cy - oy;
    await cdp(tabId, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function() {
        const cx = ${elemCx}, cy = ${elemCy};
        ['mouseenter', 'mouseover', 'mousedown', 'mouseup'].forEach(type => {
          this.dispatchEvent(new MouseEvent(type, {
            view: window, bubbles: true, cancelable: true,
            clientX: cx, clientY: cy,
          }));
        });

        // Explicit click for buttons that only listen to 'click' (not mousedown/up).
        // Skip for toggle/dropdown controls to avoid double-toggling.
        const isToggle = this.hasAttribute('aria-expanded') ||
                         this.hasAttribute('aria-pressed') ||
                         this.hasAttribute('aria-haspopup');
        if (!isToggle) {
          this.dispatchEvent(new MouseEvent('click', {
            view: window, bubbles: true, cancelable: true,
            clientX: cx, clientY: cy,
          }));
        }

        // Radio button fix for React controlled components:
        // React tracks input state internally. If we just set el.checked = true and
        // dispatch 'change', React sees "old tracked value === new value" and skips
        // the update. Using the native HTMLInputElement prototype setter bypasses
        // React's property descriptor so it sees a real change.
        // Also needed for LWC shadow DOM: 'change' is not composed by default so it
        // won't cross shadow boundaries — but React 17+ attaches listeners to the
        // React root (inside the shadow), so bubbling within the shadow is enough.
        if (this.type === 'radio' && !this.checked) {
          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'checked'
          )?.set;
          if (setter) setter.call(this, true);
          this.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
          this.dispatchEvent(new Event('input',  { bubbles: true, cancelable: true }));
        }
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

export async function execDoubleClick(step, tabId, contextId, cdp, iframeOffset = null) {
  const objectId = await resolveObjectId(step.selectors, tabId, contextId, cdp);
  const ox = iframeOffset?.x ?? 0;
  const oy = iframeOffset?.y ?? 0;
  let cx, cy;
  if (objectId) {
    const box = await scrollIntoViewAndGetRect(objectId, tabId, cdp);
    if (box) {
      cx = box.x + (step.offsetX ?? 0) + ox;
      cy = box.y + (step.offsetY ?? 0) + oy;
    }
  }
  if (cx == null) {
    const { x, y } = await resolveSelector(
      step.selectors,
      tabId,
      contextId,
      cdp
    );
    cx = x + (step.offsetX ?? 0) + ox;
    cy = y + (step.offsetY ?? 0) + oy;
  }

  await dispatchMouse(tabId, "mouseMoved", cx, cy, "none", 0, cdp);
  await dispatchMouse(tabId, "mousePressed", cx, cy, "left", 1, cdp);
  await dispatchMouse(tabId, "mouseReleased", cx, cy, "left", 1, cdp);
  await dispatchMouse(tabId, "mousePressed", cx, cy, "left", 2, cdp);
  await dispatchMouse(tabId, "mouseReleased", cx, cy, "left", 2, cdp);
}

// ── hover ──────────────────────────────────────────────────────────────────────

export async function execHover(step, tabId, contextId, cdp, iframeOffset = null) {
  const objectId = await resolveObjectId(step.selectors, tabId, contextId, cdp);
  const ox = iframeOffset?.x ?? 0;
  const oy = iframeOffset?.y ?? 0;
  let cx, cy;
  if (objectId) {
    const box = await scrollIntoViewAndGetRect(objectId, tabId, cdp);
    if (box) {
      cx = box.x + (step.offsetX ?? 0) + ox;
      cy = box.y + (step.offsetY ?? 0) + oy;
    }
  }
  if (cx == null) {
    const { x, y } = await resolveSelector(
      step.selectors,
      tabId,
      contextId,
      cdp
    );
    cx = x + (step.offsetX ?? 0) + ox;
    cy = y + (step.offsetY ?? 0) + oy;
  }
  await dispatchMouse(tabId, "mouseMoved", cx, cy, "none", 0, cdp);
}
