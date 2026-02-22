import { resolveSelector, waitForSelector } from './selector-resolver.js';
import { NAV_TIMEOUT_MS, STEP_TIMEOUT_MS } from './constants.js';

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
    case 'keyDown':        return execKeyDown(step, tabId, cdp);
    case 'keyUp':          return execKeyUp(step, tabId, cdp);
    case 'waitForElement': return execWaitForElement(step, tabId, contextId, cdp);
    case 'scroll':         return execScroll(step, tabId, contextId, cdp);
    case 'copy':           return execCopy(step, tabId, contextId, clipboardVars, cdp);
    case 'paste':          return execPaste(step, tabId, contextId, clipboardVars, cdp);
    case 'saveVariable':   return execSaveVariable(step, tabId, contextId, cdp, variables);
    case 'pasteVariable':  return execPasteVariable(step, tabId, contextId, cdp, variables);
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

  // Check if the tab is already navigating (e.g., a preceding click step triggered it)
  // or already at the target URL. Use chrome.tabs.get — available in the SW context.
  const tab = await chrome.tabs.get(tabId);

  if (tab.status === 'loading') {
    // Navigation already in progress — wait for it to complete instead of
    // calling Page.navigate again (which would interrupt the ongoing load).
    await waitForNavigation(tabId, NAV_TIMEOUT_MS);
    await sleep(300);
    return;
  }

  if (targetUrl && normalizeUrl(tab.url ?? '') === normalizeUrl(targetUrl)) {
    // Already at the target URL and fully loaded — nothing to do.
    await sleep(300);
    return;
  }

  // Explicit navigation needed (e.g., address-bar navigation recorded without a click).
  const navPromise = waitForNavigation(tabId, NAV_TIMEOUT_MS);
  await cdp(tabId, 'Page.navigate', { url: targetUrl });
  await navPromise;
  // Small settle delay for JS frameworks to initialise
  await sleep(300);
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
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.debugger.onEvent.removeListener(handler);
      reject(new Error(`Navigation timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    function handler(source, method) {
      if (source.tabId === tabId && method === 'Page.loadEventFired') {
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
  const { x, y } = await resolveSelector(step.selectors, tabId, contextId, cdp);
  const cx = x + (step.offsetX ?? 0);
  const cy = y + (step.offsetY ?? 0);

  const hasNav = step.assertedEvents?.some(e => e.type === 'navigation');
  const navPromise = hasNav ? waitForNavigation(tabId, NAV_TIMEOUT_MS) : null;

  await dispatchMouse(tabId, 'mouseMoved',   cx, cy, 'none', 0, cdp);
  await dispatchMouse(tabId, 'mousePressed', cx, cy, 'left', 1, cdp);

  if (step.duration) await sleep(step.duration);

  await dispatchMouse(tabId, 'mouseReleased', cx, cy, 'left', 1, cdp);

  if (navPromise) {
    await navPromise;
    await sleep(300);
  }
}

// ── doubleClick ────────────────────────────────────────────────────────────────

async function execDoubleClick(step, tabId, contextId, cdp) {
  const { x, y } = await resolveSelector(step.selectors, tabId, contextId, cdp);
  const cx = x + (step.offsetX ?? 0);
  const cy = y + (step.offsetY ?? 0);

  await dispatchMouse(tabId, 'mouseMoved',   cx, cy, 'none', 0, cdp);
  await dispatchMouse(tabId, 'mousePressed', cx, cy, 'left', 1, cdp);
  await dispatchMouse(tabId, 'mouseReleased',cx, cy, 'left', 1, cdp);
  await dispatchMouse(tabId, 'mousePressed', cx, cy, 'left', 2, cdp);
  await dispatchMouse(tabId, 'mouseReleased',cx, cy, 'left', 2, cdp);
}

// ── hover ──────────────────────────────────────────────────────────────────────

async function execHover(step, tabId, contextId, cdp) {
  const { x, y } = await resolveSelector(step.selectors, tabId, contextId, cdp);
  const cx = x + (step.offsetX ?? 0);
  const cy = y + (step.offsetY ?? 0);
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

  if (tagName === 'SELECT') {
    // For <select>, set .value directly and fire change event
    await cdp(tabId, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function(v) {
        this.value = v;
        this.dispatchEvent(new Event('change', { bubbles: true }));
      }`,
      arguments: [{ value }],
      returnByValue: true,
    });
  } else {
    // For text inputs: focus, clear, type, fire events
    await cdp(tabId, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: 'function() { this.focus(); this.select(); this.value = ""; }',
      returnByValue: true,
    });

    // Type the value character by character using Input.insertText
    if (value) {
      await cdp(tabId, 'Input.insertText', { text: value });
    }

    // Fire reactivity events (React / Angular / Vue)
    await cdp(tabId, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function(v) {
        // Update value in case insertText didn't set it (some cases)
        if (this.value !== v) this.value = v;
        this.dispatchEvent(new Event('input',  { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
      }`,
      arguments: [{ value }],
      returnByValue: true,
    });
  }
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
    if (!sel) continue;

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
      } else if (sel.startsWith('text/')) {
        const text = sel.slice(5);
        expression = `
          [...document.querySelectorAll('a,button,span,div,td,th,li,label')]
          .find(e => e.offsetParent !== null && e.textContent.trim() === ${JSON.stringify(text)})
        `;
      } else {
        expression = `document.querySelector(${JSON.stringify(sel)})`;
      }

      const params = { expression, returnByValue: false };
      if (contextId) params.contextId = contextId;

      const res = await cdp(tabId, 'Runtime.evaluate', params);
      const objectId = res?.result?.objectId;
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
