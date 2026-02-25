import { STEP_TIMEOUT_MS, POLL_INTERVAL_MS } from './constants.js';

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
    } catch (_) { /* try next candidate */ }
  }

  // Fallback: native CDP DOM.querySelector — bypasses framework-patched querySelector (e.g. LWC)
  for (const candidate of normalized) {
    const selectorStr = candidate[0];
    if (!selectorStr || selectorStr.includes('/') || selectorStr.includes(' >>> ')) continue;
    try {
      const result = await tryResolveCDPDom(selectorStr, tabId, cdp);
      if (result) return result;
    } catch (_) {}
  }

  const tried = normalized.map(c => c[0]).join(', ');
  throw new Error(`Selector not found. Tried: ${tried}`);
}

/**
 * Wait for an element to appear (for waitForElement steps).
 */
export async function waitForSelector(selectors, tabId, contextId, cdp, timeoutMs = STEP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  const normalized = normalizeSelectors(selectors);
  // Pre-filter CSS candidates for the CDP fallback (no aria/xpath/pierce/text prefixes or >>> chains)
  const cssCandidates = normalized.filter(c => !c[0].includes('/') && !c[0].includes(' >>> '));

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
        const result = await tryResolve(candidate[0], tabId, contextId, cdp);
        if (result) return result;
        allPrimaryThrew = false; // null → CDP works, element just not there yet
      } catch (err) {
        lastCdpErr = err;
      }
    }
    // Fallback: native CDP DOM.querySelector — bypasses framework-patched querySelectorAll
    // (e.g. Salesforce LWC synthetic shadow patches document.querySelector but not CDP DOM APIs)
    for (const candidate of cssCandidates) {
      try {
        const result = await tryResolveCDPDom(candidate[0], tabId, cdp);
        if (result) return result;
      } catch (_) {}
    }

    if (allPrimaryThrew) {
      if (++consecutiveAllThrew >= 2) {
        // Every selector threw twice in a row — debugger is almost certainly detached.
        // Fail fast so the outer loop can wait for re-attachment instead of blocking here.
        throw lastCdpErr ?? new Error('CDP unavailable — debugger may be detached');
      }
    } else {
      consecutiveAllThrew = 0;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  const tried = normalized.map(c => c[0]).join(', ');
  throw new Error(`waitForElement timed out (${timeoutMs}ms). Tried: ${tried}`);
}

// ── Normalise ──────────────────────────────────────────────────────────────────

function normalizeSelectors(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  // Already string[][] — filter out any non-string entries (guards against [object Object])
  if (Array.isArray(raw[0])) return raw.filter(c => Array.isArray(c) && typeof c[0] === 'string' && c[0]);
  // Flat string[] — wrap each in an array
  return raw.filter(s => typeof s === 'string' && s).map(s => [s]);
}

// ── Main dispatch ──────────────────────────────────────────────────────────────

async function tryResolve(selectorStr, tabId, contextId, cdp) {
  if (selectorStr.startsWith('aria/'))   return resolveAria(selectorStr.slice(5), tabId, contextId, cdp);
  if (selectorStr.startsWith('xpath/'))  return resolveXPath(selectorStr.slice(6), tabId, contextId, cdp);
  if (selectorStr.startsWith('pierce/')) return resolvePierce(selectorStr.slice(7), tabId, contextId, cdp);
  if (selectorStr.startsWith('text/'))   return resolveText(selectorStr.slice(5), tabId, contextId, cdp);
  if (selectorStr.includes(' >>> '))     return resolvePierceChain(selectorStr, tabId, contextId, cdp);
  return resolveCSS(selectorStr, tabId, contextId, cdp);
}

// ── CSS ────────────────────────────────────────────────────────────────────────

async function resolveCSS(selector, tabId, contextId, cdp) {
  // Use getElementById for #id selectors — LWC (Salesforce Lightning) patches
  // document.querySelector to enforce shadow encapsulation but does NOT patch getElementById.
  const getEl = selector.startsWith('#')
    ? `document.getElementById(${JSON.stringify(selector.slice(1))})`
    : `document.querySelector(${JSON.stringify(selector)})`;
  const expr = `
    (function() {
      const el = ${getEl};
      if (!el) return null;
      const r = el.getBoundingClientRect();
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
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    })()
  `;
  return evalExpr(expr, tabId, contextId, cdp);
}

// ── ARIA ───────────────────────────────────────────────────────────────────────

async function resolveAria(spec, tabId, contextId, cdp) {
  // spec may be "Button Label" or "Button Label[role=button]"
  const roleMatch = spec.match(/\[role=["']?(\w+)["']?\]$/);
  const role   = roleMatch ? roleMatch[1] : null;
  const label  = spec.replace(/\[role=["']?\w+["']?\]$/, '').trim();

  const expr = `
    (function() {
      const label = ${JSON.stringify(label)};
      const role  = ${JSON.stringify(role)};

      function matches(el) {
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

      const el = candidates.find(matches);
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
        const r = found.getBoundingClientRect();
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
  const parts = selectorStr.split(' >>> ').map(s => s.trim()).filter(Boolean);
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
          const r = el.getBoundingClientRect();
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
      const el = [...document.querySelectorAll(tags)].find(e => {
        if (e.offsetParent === null) return false;
        // For input[type="submit"] / input[type="button"], the label is in .value, not textContent
        if (e.tagName === 'INPUT') return e.value === text;
        return e.textContent.trim() === text;
      });
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
    const { root } = await cdp(tabId, 'DOM.getDocument', { depth: 1 });
    const res = await cdp(tabId, 'DOM.querySelector', { nodeId: root.nodeId, selector: selectorStr });
    const nodeId = res?.nodeId;
    if (!nodeId) return null;
    // Resolve to a JS object so we can call getBoundingClientRect()
    const resolved = await cdp(tabId, 'DOM.resolveNode', { nodeId });
    const objectId = resolved?.object?.objectId;
    if (!objectId) return null;
    const boxRes = await cdp(tabId, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function() {
        const r = this.getBoundingClientRect();
        return { x: r.left, y: r.top, width: r.width, height: r.height };
      }`,
      returnByValue: true,
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

  const res = await cdp(tabId, 'Runtime.evaluate', params);

  if (res?.exceptionDetails) {
    throw new Error(res.exceptionDetails.text || 'Runtime.evaluate exception');
  }
  const val = res?.result?.value;
  if (!val) return null;
  return val; // { x, y, width, height }
}

// ── Utils ──────────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
