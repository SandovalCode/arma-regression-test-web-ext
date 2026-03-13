import { STEP_TIMEOUT_MS, POLL_INTERVAL_MS } from "./constants.js";

/**
 * Resolves a selectors array to an element's bounding box coordinates.
 *
 * Selector formats (from Chrome DevTools Recorder):
 *   string[][] — outer array: fallback candidates; inner array[0]: the selector string
 *   string[]   — flat array of selector strings (normalised automatically)
 *
 * Selector prefixes:
 *   aria/<label>         — ARIA label / accessible name lookup
 *   xpath/<expr>         — XPath expression
 *   pierce/<css>         — CSS selector that pierces shadow DOM
 *   text/<string>        — visible text content match
 *   everything else      — plain CSS selector
 *
 * Returns { x, y, width, height, objectId } or throws if not found.
 */
export async function resolveSelector(selectors, tabId, contextId, cdp) {
  const normalized = normalizeSelectors(selectors);

  for (const candidate of normalized) {
    const selectorStr = candidate[0];
    if (!selectorStr) continue;
    try {
      const result = await tryResolve(selectorStr, tabId, contextId, cdp);
      if (result) return result;
    } catch (_) {
      /* try next candidate */
    }
  }

  // Fallback: native CDP DOM.querySelector — bypasses framework-patched querySelector (e.g. LWC)
  for (const candidate of normalized) {
    const selectorStr = candidate[0];
    if (
      !selectorStr ||
      selectorStr.includes("/") ||
      selectorStr.includes(" >>> ")
    )
      continue;
    try {
      const result = await tryResolveCDPDom(selectorStr, tabId, cdp);
      if (result) return result;
    } catch (e) {
      console.error(e);
    }
  }

  const tried = normalized.map((c) => c[0]).join(", ");
  throw new Error(`Selector not found. Tried: ${tried}`);
}

/**
 * Wait for an element to appear (for waitForElement steps).
 */
export async function waitForSelector(
  selectors,
  tabId,
  contextId,
  cdp,
  timeoutMs = STEP_TIMEOUT_MS,
  frameInfo = null  // optional: { frameContextMap, frameId } — enables stale-context recovery
) {
  const deadline = Date.now() + timeoutMs;
  // mutable — refreshed inline if the iframe's execution context is replaced mid-poll
  let currentContextId = contextId;
  const normalized = normalizeSelectors(selectors);
  // Pre-filter CSS candidates for the CDP fallback (no aria/xpath/pierce/text prefixes or >>> chains)
  const cssCandidates = normalized.filter(
    (c) => !c[0].includes("/") && !c[0].includes(" >>> ")
  );

  // Tracks consecutive poll iterations where every primary tryResolve call threw
  // (as opposed to returning null = "element not found").  A throw means a CDP error —
  // almost certainly a detached debugger.  After 2 in a row, fail fast instead of
  // burning the full 30-second timeout.
  let consecutiveAllThrew = 0;
  let lastCdpErr = null;

  while (Date.now() < deadline) {
    // allPrimaryThrew starts true; flips false the moment any candidate returns null
    // (meaning CDP is alive but element not present yet).
    let allPrimaryThrew = normalized.length > 0;

    for (const candidate of normalized) {
      try {
        const result = await tryResolve(candidate[0], tabId, currentContextId, cdp);
        if (result) return result;
        allPrimaryThrew = false; // null → CDP works, element just not there yet
      } catch (err) {
        // "Cannot find context" means the iframe's execution context was replaced
        // (blank-document context destroyed when the iframe loaded its real src URL).
        // This is NOT a debugger detach — refresh contextId from frameContextMap and retry.
        if (frameInfo && err.message?.includes("Cannot find context")) {
          const fresh = frameInfo.frameContextMap.get(frameInfo.frameId);
          if (fresh && fresh !== currentContextId) {
            currentContextId = fresh;
          }
          allPrimaryThrew = false;
        } else {
          lastCdpErr = err;
        }
      }
    }
    // Fallback: native CDP DOM.querySelector — bypasses framework-patched querySelectorAll
    // (e.g. Salesforce LWC synthetic shadow patches document.querySelector but not CDP DOM APIs)
    for (const candidate of cssCandidates) {
      try {
        const result = await tryResolveCDPDom(candidate[0], tabId, cdp);
        if (result) return result;
      } catch (e) {
        console.error(e);
      }
    }

    // Presence-only fallback: element exists in DOM but has zero bounding rect.
    // Common for radio/checkbox inputs styled with CSS (opacity:0, position:absolute,
    // width:0/height:0) where the native control is hidden and replaced by a custom UI.
    // waitForElement just needs to confirm the element is present — it does not need
    // coordinates. resolveSelector (used for clicks) still requires non-zero dimensions.
    for (const candidate of cssCandidates) {
      try {
        const present = await checkPresence(candidate[0], tabId, currentContextId, cdp);
        if (present) {
          console.log(`[waitForSelector] found via presence-only check: ${candidate[0]}`);
          return { x: 0, y: 0, width: 0, height: 0 };
        }
        allPrimaryThrew = false; // CDP responded — not a debugger detach
      } catch (_) {}
    }

    if (allPrimaryThrew) {
      if (++consecutiveAllThrew >= 2) {
        // Every selector threw twice in a row — debugger is almost certainly detached.
        // Fail fast so the outer loop can wait for re-attachment instead of blocking here.
        throw (
          lastCdpErr ?? new Error("CDP unavailable — debugger may be detached")
        );
      }
    } else {
      consecutiveAllThrew = 0;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  const tried = normalized.map((c) => c[0]).join(", ");
  throw new Error(`waitForElement timed out (${timeoutMs}ms). Tried: ${tried}`);
}

// ── Normalise ──────────────────────────────────────────────────────────────────

function normalizeSelectors(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  // Already string[][] — filter out any non-string entries (guards against [object Object])
  if (Array.isArray(raw[0]))
    return raw.filter(
      (c) => Array.isArray(c) && typeof c[0] === "string" && c[0]
    );
  // Flat string[] — wrap each in an array
  return raw.filter((s) => typeof s === "string" && s).map((s) => [s]);
}

// ── Main dispatch ──────────────────────────────────────────────────────────────

async function tryResolve(selectorStr, tabId, contextId, cdp) {
  if (selectorStr.startsWith("aria/"))
    return resolveAria(selectorStr.slice(5), tabId, contextId, cdp);
  if (selectorStr.startsWith("xpath/"))
    return resolveXPath(selectorStr.slice(6), tabId, contextId, cdp);
  if (selectorStr.startsWith("pierce/"))
    return resolvePierce(selectorStr.slice(7), tabId, contextId, cdp);
  if (selectorStr.startsWith("text/"))
    return resolveText(selectorStr.slice(5), tabId, contextId, cdp);
  if (selectorStr.includes(" >>> "))
    return resolvePierceChain(selectorStr, tabId, contextId, cdp);
  return resolveCSS(selectorStr, tabId, contextId, cdp);
}

// ── CSS ────────────────────────────────────────────────────────────────────────

async function resolveCSS(selector, tabId, contextId, cdp) {
  // Use getElementById for #id selectors — LWC (Salesforce Lightning) patches
  // document.querySelector to enforce shadow encapsulation but does NOT patch getElementById.
  const getEl = selector.startsWith("#")
    ? `document.getElementById(${JSON.stringify(selector.slice(1))})`
    : `document.querySelector(${JSON.stringify(selector)})`;
  const expr = `
    (function() {
      const el = ${getEl};
      if (!el) return null;
      const s = window.getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return null;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') return null;
      if ((el.tagName === 'BUTTON' || el.tagName === 'A' || el.getAttribute('role') === 'button') && s.cursor === 'not-allowed') return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    })()
  `;
  return evalExpr(expr, tabId, contextId, cdp);
}

// ── XPath ──────────────────────────────────────────────────────────────────────

async function resolveXPath(xpath, tabId, contextId, cdp) {
  const expr = `
    (function() {
      const result = document.evaluate(
        ${JSON.stringify(xpath)}, document, null,
        XPathResult.FIRST_ORDERED_NODE_TYPE, null
      );
      const el = result.singleNodeValue;
      if (!el) return null;
      const s = window.getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return null;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') return null;
      if ((el.tagName === 'BUTTON' || el.tagName === 'A' || el.getAttribute('role') === 'button') && s.cursor === 'not-allowed') return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    })()
  `;
  return evalExpr(expr, tabId, contextId, cdp);
}

// ── ARIA ───────────────────────────────────────────────────────────────────────

async function resolveAria(spec, tabId, contextId, cdp) {
  // spec may be "Button Label" or "Button Label[role=button]"
  const roleMatch = spec.match(/\[role=["']?(\w+)["']?\]$/);
  const role = roleMatch ? roleMatch[1] : null;
  const label = spec.replace(/\[role=["']?\w+["']?\]$/, "").trim();

  const expr = `
    (function() {
      const label = ${JSON.stringify(label)};
      const role  = ${JSON.stringify(role)};

      function isVisible(el) {
        const s = window.getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return false;
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
        if ((el.tagName === 'BUTTON' || el.tagName === 'A' || el.getAttribute('role') === 'button') && s.cursor === 'not-allowed') return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 || r.height > 0;
      }

      function labelMatches(el) {
        // aria-label
        if (el.getAttribute('aria-label') === label) return true;
        // aria-labelledby
        const lbId = el.getAttribute('aria-labelledby');
        if (lbId) {
          const ref = document.getElementById(lbId);
          if (ref && ref.textContent.trim() === label) return true;
        }
        // label[for=id]
        if (el.id) {
          const lbl = document.querySelector('label[for=' + JSON.stringify(el.id) + ']');
          if (lbl && lbl.textContent.trim() === label) return true;
        }
        // text content for interactive elements
        const implicit = ['button','a','[role]'].some(s => el.matches(s));
        if (implicit && el.textContent.trim() === label) return true;
        return false;
      }

      const candidates = role
        ? [...document.querySelectorAll('[role=' + JSON.stringify(role) + ']')]
        : [...document.querySelectorAll('button,a,input,select,textarea,[role],[aria-label],[aria-labelledby]')];

      // Find the first candidate that matches the label AND is visible/enabled.
      // Checking visibility inside the predicate (not after find) ensures we skip
      // hidden elements with the same label and continue to the visible one.
      const el = candidates.find(el => labelMatches(el) && isVisible(el));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    })()
  `;
  return evalExpr(expr, tabId, contextId, cdp);
}

// ── Pierce (shadow DOM) ────────────────────────────────────────────────────────

async function resolvePierce(cssSelector, tabId, contextId, cdp) {
  const expr = `
    (function piercedQS(root, sel) {
      const found = root.querySelector(sel);
      if (found) {
        const s = window.getComputedStyle(found);
        if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return null;
        if (found.disabled || found.getAttribute('aria-disabled') === 'true') return null;
        if ((found.tagName === 'BUTTON' || found.tagName === 'A' || found.getAttribute('role') === 'button') && s.cursor === 'not-allowed') return null;
        const r = found.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return null;
        return { x: r.left, y: r.top, width: r.width, height: r.height };
      }
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) {
          const res = piercedQS(el.shadowRoot, sel);
          if (res) return res;
        }
      }
      return null;
    })(document, ${JSON.stringify(cssSelector)})
  `;
  return evalExpr(expr, tabId, contextId, cdp);
}

// ── Pierce chain (a >>> b >>> c) ───────────────────────────────────────────────
// Supports Puppeteer-style deep combinator: "c-parent >>> button.save-btn"
// Each segment selects inside the previous element's shadow root.

async function resolvePierceChain(selectorStr, tabId, contextId, cdp) {
  const parts = selectorStr
    .split(" >>> ")
    .map((s) => s.trim())
    .filter(Boolean);
  const expr = `
    (function() {
      const parts = ${JSON.stringify(parts)};
      let root = document;
      for (let i = 0; i < parts.length; i++) {
        const el = root.querySelector(parts[i]);
        if (!el) return null;
        if (i < parts.length - 1) {
          root = el.shadowRoot;
          if (!root) return null;
        } else {
          const s = window.getComputedStyle(el);
          if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return null;
          if (el.disabled || el.getAttribute('aria-disabled') === 'true') return null;
          if ((el.tagName === 'BUTTON' || el.tagName === 'A' || el.getAttribute('role') === 'button') && s.cursor === 'not-allowed') return null;
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) return null;
          return { x: r.left, y: r.top, width: r.width, height: r.height };
        }
      }
      return null;
    })()
  `;
  return evalExpr(expr, tabId, contextId, cdp);
}

// ── Text ───────────────────────────────────────────────────────────────────────

async function resolveText(text, tabId, contextId, cdp) {
  const expr = `
    (function() {
      const text = ${JSON.stringify(text)};
      const tags = 'a,button,span,div,td,th,li,label,p,h1,h2,h3,h4,h5,h6,input[type="button"],input[type="submit"]';

      function isVisible(e) {
        const s = window.getComputedStyle(e);
        if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return false;
        if (e.disabled || e.getAttribute('aria-disabled') === 'true') return false;
        if ((e.tagName === 'BUTTON' || e.tagName === 'A' || e.getAttribute('role') === 'button') && s.cursor === 'not-allowed') return false;
        const r = e.getBoundingClientRect();
        return r.width > 0 || r.height > 0;
      }

      function matches(e) {
        if (!isVisible(e)) return false;
        if (e.tagName === 'INPUT') return e.value === text;
        return e.textContent.trim() === text;
      }

      // Recursive shadow-piercing search — LWC shadow roots are not reached by
      // document.querySelectorAll, so we must descend into each shadowRoot manually.
      function findInRoot(root) {
        const found = [...root.querySelectorAll(tags)].find(matches);
        if (found) return found;
        for (const host of root.querySelectorAll('*')) {
          if (host.shadowRoot) {
            const r = findInRoot(host.shadowRoot);
            if (r) return r;
          }
        }
        return null;
      }

      const el = findInRoot(document);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    })()
  `;
  return evalExpr(expr, tabId, contextId, cdp);
}

// ── CDP DOM fallback (bypasses JS-patched querySelector) ───────────────────────
// Uses Chrome's native DOM.querySelector C++ implementation, which is not affected
// by any JavaScript patches (e.g. Salesforce LWC synthetic shadow).

async function tryResolveCDPDom(selectorStr, tabId, cdp) {
  try {
    const { root } = await cdp(tabId, "DOM.getDocument", { depth: 1 });
    const res = await cdp(tabId, "DOM.querySelector", {
      nodeId: root.nodeId,
      selector: selectorStr
    });
    const nodeId = res?.nodeId;
    if (!nodeId) return null;
    // Resolve to a JS object so we can call getBoundingClientRect()
    const resolved = await cdp(tabId, "DOM.resolveNode", { nodeId });
    const objectId = resolved?.object?.objectId;
    if (!objectId) return null;
    const boxRes = await cdp(tabId, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function() {
        const s = window.getComputedStyle(this);
        if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return null;
        if (this.disabled || this.getAttribute('aria-disabled') === 'true') return null;
        if ((this.tagName === 'BUTTON' || this.tagName === 'A' || this.getAttribute('role') === 'button') && s.cursor === 'not-allowed') return null;
        const r = this.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return null;
        return { x: r.left, y: r.top, width: r.width, height: r.height };
      }`,
      returnByValue: true
    });
    return boxRes?.result?.value ?? null;
  } catch (_) {
    return null;
  }
}

// ── Eval helper ────────────────────────────────────────────────────────────────

async function evalExpr(expression, tabId, contextId, cdp) {
  const params = { expression, returnByValue: true };
  if (contextId) params.contextId = contextId;

  const res = await cdp(tabId, "Runtime.evaluate", params);

  if (res?.exceptionDetails) {
    throw new Error(res.exceptionDetails.text || "Runtime.evaluate exception");
  }
  const val = res?.result?.value;
  if (!val) return null;
  return val; // { x, y, width, height }
}

// ── DOM-presence check (no visibility or bounding-rect requirement) ────────────
// Returns true if document.querySelector finds the element regardless of its size,
// UNLESS the element is hidden via display:none.
//
// Used by waitForSelector as a last-resort fallback for CSS-hidden form controls
// (e.g. radio/checkbox inputs with opacity:0 or width:0/height:0 replaced by
// custom CSS UI). These elements are interactive even though invisible.
//
// display:none is explicitly excluded: it means the element is fully hidden by the
// page (e.g. a PHP multi-step wizard where the next section isn't shown yet).
// Returning true for display:none would cause execClick to fire at (0,0) coords
// instead of waiting for the element to actually become visible.

async function checkPresence(selectorStr, tabId, contextId, cdp) {
  const expression = `(function() {
    const el = document.querySelector(${JSON.stringify(selectorStr)});
    if (!el) return false;
    // display:none means the page has intentionally hidden this element — keep waiting
    if (window.getComputedStyle(el).display === 'none') return false;
    return true;
  })()`;
  const params = { expression, returnByValue: true };
  if (contextId) params.contextId = contextId;
  // Let CDP errors (e.g. detached debugger) propagate — the caller uses thrown
  // errors to detect that the debugger is gone and exit the polling loop fast.
  const res = await cdp(tabId, "Runtime.evaluate", params);
  if (res?.exceptionDetails) return false;
  return res?.result?.value === true;
}

// ── Utils ──────────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
