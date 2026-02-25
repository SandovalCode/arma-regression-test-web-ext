import { resolveSelector, waitForSelector } from './selector-resolver.js';
import { NAV_TIMEOUT_MS, STEP_TIMEOUT_MS, POLLING_DOMAINS } from './constants.js';

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
export async function executeStep(step, tabId, frameContextMap, clipboardVars, cdp, variables = new Map()) {
  // Resolve the correct execution context for this step's frame
  const contextId = resolveContext(step, frameContextMap);

  switch (step.type) {
    case 'setViewport':    return execSetViewport(step, tabId, cdp);
    case 'navigate':       return execNavigate(step, tabId, cdp);
    case 'click':          return execClick(step, tabId, contextId, cdp);
    case 'doubleClick':    return execDoubleClick(step, tabId, contextId, cdp);
    case 'hover':          return execHover(step, tabId, contextId, cdp);
    case 'change':         return execChange(step, tabId, contextId, cdp);
    case 'selectOption':   return execSelectOption(step, tabId, contextId, cdp);
    case 'keyDown':        return execKeyDown(step, tabId, cdp);
    case 'keyUp':          return execKeyUp(step, tabId, cdp);
    case 'waitForElement':  return execWaitForElement(step, tabId, contextId, cdp);
    case 'waitForPageLoad': return execWaitForPageLoad(tabId, cdp);
    case 'scroll':         return execScroll(step, tabId, contextId, cdp);
    case 'copy':           return execCopy(step, tabId, contextId, clipboardVars, cdp);
    case 'paste':          return execPaste(step, tabId, contextId, clipboardVars, cdp);
    case 'saveVariable':   return execSaveVariable(step, tabId, contextId, cdp, variables);
    case 'pasteVariable':  return execPasteVariable(step, tabId, contextId, cdp, variables);
    case 'wait':           return sleep(Math.max(0, step.duration ?? 0));
    default:
      // Unknown step types are silently skipped so new recorder formats don't crash
      console.warn(`[step-executor] Unknown step type: ${step.type} — skipping`);
  }
}

// ── Context resolution ─────────────────────────────────────────────────────────

function resolveContext(step, _frameContextMap) {
  if (!step.frame || step.frame.length === 0) return null;
  // The frameContextMap is keyed by frameId strings.
  // We can't easily map frame index arrays to frameIds here without querying
  // Page.getFrameTree again; for now we return null and let the CDP call use
  // the main context. Frame-specific resolution is handled in execNavigateFrame.
  // TODO: enhance with Page.getFrameTree lookup for full iframe support.
  return null;
}

// ── setViewport ────────────────────────────────────────────────────────────────

async function execSetViewport(step, tabId, cdp) {
  await cdp(tabId, 'Emulation.setDeviceMetricsOverride', {
    width:             step.width ?? 1280,
    height:            step.height ?? 720,
    deviceScaleFactor: step.deviceScaleFactor ?? 1,
    mobile:            step.isMobile ?? false,
  });
}

// ── navigate ───────────────────────────────────────────────────────────────────

async function execNavigate(step, tabId, cdp) {
  const targetUrl = step.url ?? '';
  if (!targetUrl) return;

  const tab = await chrome.tabs.get(tabId);

  if (tab.status === 'loading') {
    // tab.pendingUrl is the in-flight destination URL (more reliable than tab.url here).
    const pendingUrl = tab.pendingUrl || tab.url || '';
    if (normalizeUrl(pendingUrl) === normalizeUrl(targetUrl)) {
      // Already loading to the right URL — just wait for it.
      await waitForNavigation(tabId, NAV_TIMEOUT_MS);
      await sleep(600);
      return;
    }
    // Loading to a DIFFERENT URL (e.g. a click-triggered navigation going somewhere else).
    // Wait for it to settle, then fall through to navigate explicitly to our target.
    await waitForNavigation(tabId, NAV_TIMEOUT_MS);
    // Re-check after the load completed
    const settled = await chrome.tabs.get(tabId);
    if (normalizeUrl(settled.url ?? '') === normalizeUrl(targetUrl)) {
      await sleep(600);
      return;
    }
  } else if (normalizeUrl(tab.url ?? '') === normalizeUrl(targetUrl)) {
    // Already at the target URL and fully loaded — nothing to do.
    await sleep(300);
    return;
  }

  // Explicit navigation to the target URL.
  const navPromise = waitForNavigation(tabId, NAV_TIMEOUT_MS);
  await cdp(tabId, 'Page.navigate', { url: targetUrl });
  await navPromise;
  // Longer settle: give JS frameworks (React, Angular, Vue) time to boot after load.
  await sleep(600);
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

function waitForNavigation(tabId, timeoutMs) {
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
      if (method === 'Page.loadEventFired' || method === 'Page.domContentEventFired') {
        clearTimeout(timer);
        chrome.debugger.onEvent.removeListener(handler);
        resolve();
      }
    }
    chrome.debugger.onEvent.addListener(handler);
  });
}

// ── click ──────────────────────────────────────────────────────────────────────

async function execClick(step, tabId, contextId, cdp) {
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
    // Fall back to resolveSelector if objectId resolution failed
    const { x, y } = await resolveSelector(step.selectors, tabId, contextId, cdp);
    cx = x + (step.offsetX ?? 0);
    cy = y + (step.offsetY ?? 0);
  }

  const hasNav = step.assertedEvents?.some(e => e.type === 'navigation');
  const navPromise = hasNav ? waitForNavigation(tabId, NAV_TIMEOUT_MS) : null;

  // mouseMoved triggers mouseenter on the element and all its ancestors (CDP real event).
  await dispatchMouse(tabId, 'mouseMoved', cx, cy, 'none', 0, cdp);

  // Wait for mouseenter handlers to finish before clicking.
  // Frameworks like Salesforce Aura/LWC activate/show controls in response to
  // mouseenter, and the click must arrive after that handler completes.
  await sleep(80);

  // Explicitly focus the element before pressing — mirrors what a real click does:
  // blur fires on the previously focused element, focus fires on this one.
  if (objectId) {
    await cdp(tabId, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: 'function() { this.focus(); }',
      returnByValue: true,
    }).catch(() => {});
  }

  await dispatchMouse(tabId, 'mousePressed',  cx, cy, 'left', 1, cdp);
  if (step.duration) await sleep(step.duration);
  await dispatchMouse(tabId, 'mouseReleased', cx, cy, 'left', 1, cdp);

  // Belt-and-suspenders: also fire synthetic JS events on the element.
  // Salesforce LWC (and some other frameworks) register addEventListener handlers
  // that respond to JS-dispatched events independently of the CDP hardware events.
  if (objectId) {
    await cdp(tabId, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function() {
        const cx = ${cx}, cy = ${cy};
        ['mousedown', 'mouseup', 'click'].forEach(type => {
          this.dispatchEvent(new MouseEvent(type, {
            view: window, bubbles: true, cancelable: true,
            clientX: cx, clientY: cy,
          }));
        });
      }`,
      returnByValue: true,
    }).catch(() => {});
  }

  if (navPromise) {
    await navPromise;
    await sleep(300);
  }
}

// ── doubleClick ────────────────────────────────────────────────────────────────

async function execDoubleClick(step, tabId, contextId, cdp) {
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
    const { x, y } = await resolveSelector(step.selectors, tabId, contextId, cdp);
    cx = x + (step.offsetX ?? 0);
    cy = y + (step.offsetY ?? 0);
  }

  await dispatchMouse(tabId, 'mouseMoved',   cx, cy, 'none', 0, cdp);
  await dispatchMouse(tabId, 'mousePressed', cx, cy, 'left', 1, cdp);
  await dispatchMouse(tabId, 'mouseReleased',cx, cy, 'left', 1, cdp);
  await dispatchMouse(tabId, 'mousePressed', cx, cy, 'left', 2, cdp);
  await dispatchMouse(tabId, 'mouseReleased',cx, cy, 'left', 2, cdp);
}

// ── hover ──────────────────────────────────────────────────────────────────────

async function execHover(step, tabId, contextId, cdp) {
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
    const { x, y } = await resolveSelector(step.selectors, tabId, contextId, cdp);
    cx = x + (step.offsetX ?? 0);
    cy = y + (step.offsetY ?? 0);
  }
  await dispatchMouse(tabId, 'mouseMoved', cx, cy, 'none', 0, cdp);
}

// ── change (text input, select) ────────────────────────────────────────────────

async function execChange(step, tabId, contextId, cdp) {
  const value = step.value ?? '';

  // We need the objectId to call functions on the element
  const objectId = await resolveObjectId(step.selectors, tabId, contextId, cdp);
  if (!objectId) throw new Error(`Could not resolve element for change step. Tried: ${JSON.stringify(step.selectors)}`);

  // Determine if it's a <select>
  const tagRes = await cdp(tabId, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: 'function() { return this.tagName; }',
    returnByValue: true,
  });
  const tagName = tagRes?.result?.value ?? '';

  // A step recorded from a <select> always has step.label set
  const isSelectStep = tagName === 'SELECT' || step.label !== undefined;

  if (isSelectStep) {
    // Set the value on the select. Fire change without bubbling so parent form
    // handlers (which could cause unwanted navigation) are not triggered.
    await cdp(tabId, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function() {
        this.value = ${JSON.stringify(value)};
        this.dispatchEvent(new Event('change', { bubbles: false, cancelable: true }));
      }`,
      returnByValue: true,
    });
  } else {
    // For text inputs: insert full text then fire events
    await cdp(tabId, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: 'function() { this.focus(); this.select(); this.value = ""; }',
      returnByValue: true,
    });

    if (value) {
      await cdp(tabId, 'Input.insertText', { text: value.slice(0, 10) });
    }

    await cdp(tabId, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function() {
        this.dispatchEvent(new Event('input',  { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
        this.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
      }`,
      returnByValue: true,
    });

    await tryClickAutocompleteOption(value, tabId, contextId, cdp);
  }
}

// ── selectOption ───────────────────────────────────────────────────────────────

async function execSelectOption(step, tabId, contextId, cdp) {
  const objectId = await resolveObjectId(step.selectors, tabId, contextId, cdp);
  if (!objectId) throw new Error(`selectOption: could not find select. Tried: ${JSON.stringify(step.selectors)}`);

  await cdp(tabId, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function() {
      this.value = ${JSON.stringify(step.value)};
      this.dispatchEvent(new Event('change', { bubbles: false, cancelable: true }));
    }`,
    returnByValue: true,
  });
}

// ── Autocomplete option picker ──────────────────────────────────────────────────
// After typing into an autocomplete field, find the visible option whose text
// matches `targetText` exactly and click it.  Falls back to partial match.
async function tryClickAutocompleteOption(targetText, tabId, contextId, cdp) {
  const result = await cdp(tabId, 'Runtime.evaluate', {
    expression: `
      (function(target) {
        const selectors = [
          '[role="option"]',
          '[role="listbox"] [role="option"]',
          '[role="listbox"] li',
          '[role="listbox"] *',
          'datalist option',
          'ul[class*="suggest"] li',
          'ul[class*="auto"] li',
          'div[class*="suggest"] *',
          'div[class*="dropdown"] *',
        ];

        // Collect all visible candidate elements
        const seen = new Set();
        const candidates = [];
        for (const sel of selectors) {
          for (const el of document.querySelectorAll(sel)) {
            if (!seen.has(el)) {
              seen.add(el);
              candidates.push(el);
            }
          }
        }

        // Exact match first, then partial
        for (const pass of ['exact', 'partial']) {
          for (const el of candidates) {
            const text = (el.textContent ?? el.getAttribute('value') ?? '').trim();
            const matches = pass === 'exact' ? text === target : text.toLowerCase().includes(target.toLowerCase());
            if (!matches) continue;
            // Must be visible
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            if (el.offsetParent === null) continue;
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          }
        }
        return null;
      })(${JSON.stringify(targetText)})
    `,
    contextId,
    returnByValue: true,
  });

  const coords = result?.result?.value;
  if (!coords) return false;

  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved',    x: coords.x, y: coords.y, button: 'none', clickCount: 0 });
  await sleep(50);
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed',  x: coords.x, y: coords.y, button: 'left', clickCount: 1 });
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: coords.x, y: coords.y, button: 'left', clickCount: 1 });

  return true;
}

// ── keyDown / keyUp ────────────────────────────────────────────────────────────

const KEY_MODIFIERS = {
  Alt:     1,
  Control: 2,
  Meta:    4,
  Shift:   8,
};

async function execKeyDown(step, tabId, cdp) {
  const modifiers = KEY_MODIFIERS[step.key] ?? 0;
  await cdp(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: step.key,
    modifiers,
  });
}

async function execKeyUp(step, tabId, cdp) {
  const modifiers = KEY_MODIFIERS[step.key] ?? 0;
  await cdp(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: step.key,
    modifiers,
  });
}

// ── waitForElement ─────────────────────────────────────────────────────────────

async function execWaitForElement(step, tabId, contextId, cdp) {
  await waitForSelector(step.selectors, tabId, contextId, cdp, STEP_TIMEOUT_MS);
}

async function execWaitForPageLoad(tabId, cdp) {
  // For domains that poll continuously (e.g. Salesforce Lightning), readyState
  // never reaches 'complete'. Detect these by hostname and use a fixed sleep.
  try {
    const tab = await chrome.tabs.get(tabId);
    const hostname = new URL(tab.url ?? '').hostname;
    if (POLLING_DOMAINS.some(d => hostname.endsWith(d))) {
      await sleep(3000);
      return;
    }
  } catch (_) {}

  // Normal pages: wait for 'complete', fall back to 'interactive' + 2s settle.
  const INTERACTIVE_SETTLE_MS = 2000;
  const deadline = Date.now() + NAV_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const res = await cdp(tabId, 'Runtime.evaluate', {
      expression: 'document.readyState',
      returnByValue: true,
    });
    const state = res?.result?.value;
    if (state === 'complete') return;
    if (state === 'interactive') {
      await sleep(INTERACTIVE_SETTLE_MS);
      return;
    }
    await sleep(500);
  }
  // Timed out — continue anyway
}

// ── scroll ─────────────────────────────────────────────────────────────────────

async function execScroll(step, tabId, contextId, cdp) {
  // If selectors provided, scroll to the element first
  if (step.selectors?.length) {
    try {
      const { x, y } = await resolveSelector(step.selectors, tabId, contextId, cdp);
      await dispatchMouse(tabId, 'mouseWheel', x, y, 'none', 0, cdp, {
        deltaX: step.x ?? 0,
        deltaY: step.y ?? 0,
      });
      return;
    } catch (_) {}
  }
  // Fallback: scroll the page
  await cdp(tabId, 'Runtime.evaluate', {
    expression: `window.scrollBy(${step.x ?? 0}, ${step.y ?? 0})`,
  });
}

// ── copy ───────────────────────────────────────────────────────────────────────

async function execCopy(step, tabId, contextId, clipboardVars, cdp) {
  // Capture the currently selected text or focused input's value at runtime
  const res = await cdp(tabId, 'Runtime.evaluate', {
    expression: `
      (function() {
        const sel = window.getSelection()?.toString();
        if (sel) return sel;
        const el = document.activeElement;
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
          const sub = el.value.slice(el.selectionStart, el.selectionEnd);
          return sub || el.value;
        }
        return '';
      })()
    `,
    returnByValue: true,
    ...(contextId ? { contextId } : {}),
  });

  const captured = res?.result?.value ?? step.snapshotValue ?? '';
  clipboardVars.set(step.variableName, captured);
}

// ── paste ──────────────────────────────────────────────────────────────────────

async function execPaste(step, tabId, contextId, clipboardVars, cdp) {
  // Retrieve value from the in-memory clipboard variable
  const textToPaste = clipboardVars.get(step.variableName) ?? step.snapshotValue ?? '';
  if (!textToPaste) return; // nothing to paste

  const objectId = await resolveObjectId(step.selectors, tabId, contextId, cdp);
  if (!objectId) throw new Error(`Could not resolve paste target. Tried: ${JSON.stringify(step.selectors)}`);

  // Focus, clear, insert text
  await cdp(tabId, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: 'function() { this.focus(); this.select(); this.value = ""; }',
    returnByValue: true,
  });

  await cdp(tabId, 'Input.insertText', { text: textToPaste });

  // Fire reactivity events
  await cdp(tabId, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function(v) {
      if (this.value !== v) this.value = v;
      this.dispatchEvent(new Event('input',  { bubbles: true }));
      this.dispatchEvent(new Event('change', { bubbles: true }));
    }`,
    arguments: [{ value: textToPaste }],
    returnByValue: true,
  });
}

// ── saveVariable ───────────────────────────────────────────────────────────────

async function execSaveVariable(step, tabId, contextId, cdp, variables) {
  let value = step.defaultValue ?? '';

  // Try to read the element's live value; fall back to defaultValue if unavailable.
  try {
    const objectId = await resolveObjectId(step.selectors, tabId, contextId, cdp);
    if (objectId) {
      const res = await cdp(tabId, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function() {
          if (this.tagName === 'INPUT' || this.tagName === 'TEXTAREA' || this.tagName === 'SELECT') {
            return this.value;
          }
          return this.textContent?.trim() ?? '';
        }`,
        returnByValue: true,
      });
      const current = res?.result?.value;
      if (current != null && current !== '') value = current;
    }
  } catch (_) {
    // Fall back to defaultValue captured at recording time
  }

  variables.set(step.variableName, value);
}

// ── pasteVariable ──────────────────────────────────────────────────────────────

async function execPasteVariable(step, tabId, contextId, cdp, variables) {
  // Prefer the live runtime value captured by saveVariable; fall back to the
  // defaultValue embedded in the step at recording time.
  const textToPaste = variables.get(step.variableName) ?? step.fallbackValue ?? '';
  if (!textToPaste) return; // nothing to paste

  const objectId = await resolveObjectId(step.selectors, tabId, contextId, cdp);
  if (!objectId) throw new Error(`Could not resolve paste target. Tried: ${JSON.stringify(step.selectors)}`);

  // Focus, clear, insert text
  await cdp(tabId, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: 'function() { this.focus(); this.select(); this.value = ""; }',
    returnByValue: true,
  });

  await cdp(tabId, 'Input.insertText', { text: textToPaste });

  // Fire reactivity events
  await cdp(tabId, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function(v) {
      if (this.value !== v) this.value = v;
      this.dispatchEvent(new Event('input',  { bubbles: true }));
      this.dispatchEvent(new Event('change', { bubbles: true }));
    }`,
    arguments: [{ value: textToPaste }],
    returnByValue: true,
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Resolves selectors to a Runtime objectId so we can call functions on the element.
 */
async function resolveObjectId(selectors, tabId, contextId, cdp) {
  const normalized = Array.isArray(selectors[0]) ? selectors : selectors.map(s => [s]);

  for (const candidate of normalized) {
    const sel = candidate[0];
    if (!sel || typeof sel !== 'string') continue;

    try {
      let expression;
      if (sel.startsWith('xpath/')) {
        const xp = sel.slice(6);
        expression = `document.evaluate(${JSON.stringify(xp)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue`;
      } else if (sel.startsWith('aria/')) {
        // Simplified aria lookup for objectId resolution
        const label = sel.slice(5).replace(/\[role=["']?\w+["']?\]$/, '').trim();
        expression = `
          [...document.querySelectorAll('button,a,input,select,textarea,[role],[aria-label],[aria-labelledby]')]
          .find(el =>
            el.getAttribute('aria-label') === ${JSON.stringify(label)} ||
            el.textContent.trim() === ${JSON.stringify(label)}
          )
        `;
      } else if (sel.startsWith('pierce/')) {
        const css = sel.slice(7);
        expression = `
          (function piercedQS(root, s) {
            const f = root.querySelector(s); if (f) return f;
            for (const el of root.querySelectorAll('*'))
              if (el.shadowRoot) { const r = piercedQS(el.shadowRoot, s); if (r) return r; }
            return null;
          })(document, ${JSON.stringify(css)})
        `;
      } else if (sel.includes(' >>> ')) {
        const parts = sel.split(' >>> ').map(s => s.trim()).filter(Boolean);
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
      } else if (sel.startsWith('text/')) {
        const text = sel.slice(5);
        expression = `
          [...document.querySelectorAll('a,button,span,div,td,th,li,label')]
          .find(e => e.offsetParent !== null && e.textContent.trim() === ${JSON.stringify(text)})
        `;
      } else {
        // Use getElementById for #id selectors — LWC (Salesforce) patches document.querySelector
        // to enforce shadow encapsulation but does NOT patch getElementById.
        expression = sel.startsWith('#')
          ? `document.getElementById(${JSON.stringify(sel.slice(1))})`
          : `document.querySelector(${JSON.stringify(sel)})`;
      }

      const params = { expression, returnByValue: false };
      if (contextId) params.contextId = contextId;

      const res = await cdp(tabId, 'Runtime.evaluate', params);
      const objectId = res?.result?.objectId;
      if (objectId) return objectId;
    } catch (_) {}
  }

  // Fallback: native CDP DOM.querySelector — bypasses JS-patched querySelector (e.g. LWC synthetic shadow)
  for (const candidate of normalized) {
    const sel = candidate[0];
    if (!sel || typeof sel !== 'string' || sel.includes('/') || sel.includes(' >>> ')) continue;
    try {
      const { root } = await cdp(tabId, 'DOM.getDocument', { depth: 1 });
      const res = await cdp(tabId, 'DOM.querySelector', { nodeId: root.nodeId, selector: sel });
      const nodeId = res?.nodeId;
      if (!nodeId) continue;
      const resolved = await cdp(tabId, 'DOM.resolveNode', { nodeId });
      const objectId = resolved?.object?.objectId;
      if (objectId) return objectId;
    } catch (_) {}
  }

  return null;
}

async function dispatchMouse(tabId, type, x, y, button, clickCount, cdp, extra = {}) {
  await cdp(tabId, 'Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button,
    clickCount,
    ...extra,
  });
}

/**
 * Scrolls the element into the viewport, then returns its fresh bounding rect.
 * Mirrors Playwright's approach: scroll first, then read viewport-relative coords
 * for Input.dispatchMouseEvent (which expects viewport coords, not page-absolute).
 */
async function scrollIntoViewAndGetRect(objectId, tabId, cdp) {
  await cdp(tabId, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: 'function() { this.scrollIntoView({ behavior: "instant", block: "center", inline: "center" }); }',
    returnByValue: true,
  }).catch(() => {});
  // Brief settle after scroll so the viewport position stabilises
  await sleep(100);
  const res = await cdp(tabId, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: 'function() { const r = this.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; }',
    returnByValue: true,
  }).catch(() => null);
  return res?.result?.value ?? null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
