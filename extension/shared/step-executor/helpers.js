// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Resolves selectors to a Runtime objectId so we can call functions on the element.
 */
export async function resolveObjectId(selectors, tabId, contextId, cdp) {
  const normalized = Array.isArray(selectors[0])
    ? selectors
    : selectors.map((s) => [s]);

  for (const candidate of normalized) {
    const sel = candidate[0];
    if (!sel || typeof sel !== "string") continue;

    try {
      let expression;
      if (sel.startsWith("xpath/")) {
        const xp = sel.slice(6);
        expression = `document.evaluate(${JSON.stringify(xp)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue`;
      } else if (sel.startsWith("aria/")) {
        // Simplified aria lookup for objectId resolution
        const label = sel
          .slice(5)
          .replace(/\[role=["']?\w+["']?\]$/, "")
          .trim();
        expression = `
          [...document.querySelectorAll('button,a,input,select,textarea,[role],[aria-label],[aria-labelledby]')]
          .find(el =>
            el.getAttribute('aria-label') === ${JSON.stringify(label)} ||
            el.textContent.trim() === ${JSON.stringify(label)}
          )
        `;
      } else if (sel.startsWith("pierce/")) {
        const css = sel.slice(7);
        expression = `
          (function piercedQS(root, s) {
            const f = root.querySelector(s); if (f) return f;
            for (const el of root.querySelectorAll('*'))
              if (el.shadowRoot) { const r = piercedQS(el.shadowRoot, s); if (r) return r; }
            return null;
          })(document, ${JSON.stringify(css)})
        `;
      } else if (sel.includes(" >>> ")) {
        const parts = sel
          .split(" >>> ")
          .map((s) => s.trim())
          .filter(Boolean);
        expression = `
          (function() {
            const parts = ${JSON.stringify(parts)};
            let root = document;
            for (let i = 0; i < parts.length; i++) {
              const el = root.querySelector(parts[i]);
              if (!el) return null;
              if (i < parts.length - 1) { root = el.shadowRoot; if (!root) return null; }
              else return el;
            }
            return null;
          })()
        `;
      } else if (sel.startsWith("text/")) {
        const text = sel.slice(5);
        expression = `
          (function() {
            const t = ${JSON.stringify(text)};
            const tags = 'a,button,span,div,td,th,li,label';
            function findInRoot(root) {
              const found = [...root.querySelectorAll(tags)]
                .find(e => e.offsetParent !== null && e.textContent.trim() === t);
              if (found) return found;
              for (const host of root.querySelectorAll('*')) {
                if (host.shadowRoot) {
                  const r = findInRoot(host.shadowRoot);
                  if (r) return r;
                }
              }
              return null;
            }
            return findInRoot(document);
          })()
        `;
      } else {
        // Use getElementById for #id selectors — LWC (Salesforce) patches document.querySelector
        // to enforce shadow encapsulation but does NOT patch getElementById.
        expression = sel.startsWith("#")
          ? `document.getElementById(${JSON.stringify(sel.slice(1))})`
          : `document.querySelector(${JSON.stringify(sel)})`;
      }

      const params = { expression, returnByValue: false };
      if (contextId) params.contextId = contextId;

      const res = await cdp(tabId, "Runtime.evaluate", params);
      const objectId = res?.result?.objectId;
      if (objectId) return objectId;
    } catch (e) {
      console.error(e);
    }
  }

  // Fallback: native CDP DOM.querySelector — bypasses JS-patched querySelector (e.g. LWC synthetic shadow)
  for (const candidate of normalized) {
    const sel = candidate[0];
    if (
      !sel ||
      typeof sel !== "string" ||
      sel.includes("/") ||
      sel.includes(" >>> ")
    )
      continue;
    try {
      const { root } = await cdp(tabId, "DOM.getDocument", { depth: 1 });
      const res = await cdp(tabId, "DOM.querySelector", {
        nodeId: root.nodeId,
        selector: sel
      });
      const nodeId = res?.nodeId;
      if (!nodeId) continue;
      const resolved = await cdp(tabId, "DOM.resolveNode", { nodeId });
      const objectId = resolved?.object?.objectId;
      if (objectId) return objectId;
    } catch (e) {
      console.error(e);
    }
  }

  return null;
}

export async function dispatchMouse(
  tabId,
  type,
  x,
  y,
  button,
  clickCount,
  cdp,
  extra = {}
) {
  await cdp(tabId, "Input.dispatchMouseEvent", {
    type,
    x,
    y,
    button,
    clickCount,
    ...extra
  });
}

/**
 * Scrolls the element into the viewport, then returns its fresh bounding rect.
 * Mirrors Playwright's approach: scroll first, then read viewport-relative coords
 * for Input.dispatchMouseEvent (which expects viewport coords, not page-absolute).
 */
export async function scrollIntoViewAndGetRect(objectId, tabId, cdp) {
  await cdp(tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration:
      'function() { this.scrollIntoView({ behavior: "instant", block: "center", inline: "center" }); }',
    returnByValue: true
  }).catch(console.error);
  // Brief settle after scroll so the viewport position stabilises
  await sleep(30);
  const res = await cdp(tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration:
      "function() { const r = this.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; }",
    returnByValue: true
  }).catch(console.error);
  return res?.result?.value ?? null;
}

export function waitForNavigation(tabId, timeoutMs) {
  // Resolves when the page fires loadEventFired OR domContentEventFired,
  // whichever comes first. Never rejects — if neither fires within timeoutMs
  // we proceed anyway. This handles SPAs (like Salesforce Lightning) that
  // keep the network busy after load and never fire loadEventFired.
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.debugger.onEvent.removeListener(handler);
      resolve(); // timed out — proceed anyway, don't fail the step
    }, timeoutMs);

    function handler(source, method) {
      if (source.tabId !== tabId) return;
      if (
        method === "Page.loadEventFired" ||
        method === "Page.domContentEventFired"
      ) {
        clearTimeout(timer);
        chrome.debugger.onEvent.removeListener(handler);
        resolve();
      }
    }
    chrome.debugger.onEvent.addListener(handler);
  });
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
