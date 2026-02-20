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

  const tried = normalized.map(c => c[0]).join(', ');
  throw new Error(`Selector not found. Tried: ${tried}`);
}

/**
 * Wait for an element to appear (for waitForElement steps).
 */
export async function waitForSelector(selectors, tabId, contextId, cdp, timeoutMs = STEP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  const normalized = normalizeSelectors(selectors);

  while (Date.now() < deadline) {
    for (const candidate of normalized) {
      try {
        const result = await tryResolve(candidate[0], tabId, contextId, cdp);
        if (result) return result;
      } catch (_) {}
    }
    await sleep(POLL_INTERVAL_MS);
  }

  const tried = normalized.map(c => c[0]).join(', ');
  throw new Error(`waitForElement timed out (${timeoutMs}ms). Tried: ${tried}`);
}

// ── Normalise ──────────────────────────────────────────────────────────────────

function normalizeSelectors(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  // Already string[][] ?
  if (Array.isArray(raw[0])) return raw;
  // Flat string[] — wrap each in an array
  return raw.map(s => [s]);
}

// ── Main dispatch ──────────────────────────────────────────────────────────────

async function tryResolve(selectorStr, tabId, contextId, cdp) {
  if (selectorStr.startsWith('aria/'))   return resolveAria(selectorStr.slice(5), tabId, contextId, cdp);
  if (selectorStr.startsWith('xpath/'))  return resolveXPath(selectorStr.slice(6), tabId, contextId, cdp);
  if (selectorStr.startsWith('pierce/')) return resolvePierce(selectorStr.slice(7), tabId, contextId, cdp);
  if (selectorStr.startsWith('text/'))   return resolveText(selectorStr.slice(5), tabId, contextId, cdp);
  return resolveCSS(selectorStr, tabId, contextId, cdp);
}

// ── CSS ────────────────────────────────────────────────────────────────────────

async function resolveCSS(selector, tabId, contextId, cdp) {
  const expr = `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
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
      return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
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
      return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
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
        return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
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

// ── Text ───────────────────────────────────────────────────────────────────────

async function resolveText(text, tabId, contextId, cdp) {
  const expr = `
    (function() {
      const text = ${JSON.stringify(text)};
      const tags = 'a,button,span,div,td,th,li,label,p,h1,h2,h3,h4,h5,h6,input[type="button"],input[type="submit"]';
      const el = [...document.querySelectorAll(tags)].find(
        e => e.offsetParent !== null && e.textContent.trim() === text
      );
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
    })()
  `;
  return evalExpr(expr, tabId, contextId, cdp);
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
