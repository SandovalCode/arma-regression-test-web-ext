/**
 * recorder.js — content script injected into the active tab during recording.
 * Captures user interactions and sends them as steps to the service worker.
 *
 * This script is injected dynamically (not declared in manifest.json)
 * and is re-injected after navigations within the recording tab.
 */

(function () {
  // Don't run inside chrome:// or chrome-extension:// frames (e.g. iframes from other extensions).
  // Injecting there would cause "Cannot access a chrome-extension:// URL of different extension"
  // when the content script tries to sendMessage back to the service worker.
  if (location.protocol === 'chrome-extension:' || location.protocol === 'chrome:') return;

  // Prevent double-injection on the same page
  if (window.__recorderActive) return;
  window.__recorderActive = true;

  // ── State ────────────────────────────────────────────────────────────────────
  let lastSelection = '';
  let lastSelectionEl = null;
  let lastCopiedVarName = null;
  let pendingInputChange = null;  // debounce: fire change step only on blur/change
  
  // ── Send a step to the service worker ────────────────────────────────────────
  let _lastStepKey = '';
  let _lastStepTime = 0;

  function sendStep(step) {
    // Deduplicate: ignore identical step type + selector within 200ms.
    // Covers label→input synthetic clicks, allFrames double-injection edge cases, etc.
    const key = step.type + '|' + (step.selectors?.[0]?.[0] ?? '') + '|' + (step.value ?? '') + '|' + (step.key ?? '');
    const now = Date.now();
    if (key === _lastStepKey && now - _lastStepTime < 200) return;
    _lastStepKey = key;
    _lastStepTime = now;

    try {
      chrome.runtime.sendMessage({ type: 'RECORD_STEP', payload: { step } });
    } catch (_) {
      // Extension context invalidated (e.g. extension reloaded while page is open) — ignore.
    }
  }

  // ── Selector generation ───────────────────────────────────────────────────────

  function buildCSSSelector(el) {
    if (!el || el === document.body) return null;

    // Prefer id
    if (el.id && /^[a-zA-Z][\w-]*$/.test(el.id)) return `#${el.id}`;

    // Prefer unique data-* attribute
    for (const attr of el.attributes) {
      if (attr.name.startsWith('data-') && attr.value) {
        const sel = `${el.tagName.toLowerCase()}[${attr.name}="${CSS.escape(attr.value)}"]`;
        if (document.querySelectorAll(sel).length === 1) return sel;
      }
    }

    // name attribute (inputs, selects)
    if (el.name) {
      const sel = `${el.tagName.toLowerCase()}[name="${CSS.escape(el.name)}"]`;
      if (document.querySelectorAll(sel).length === 1) return sel;
    }

    // type + class fallback
    const tag = el.tagName.toLowerCase();
    const cls = Array.from(el.classList)
      .filter(c => !/\bactive\b|\bfocus\b|\bhover\b/.test(c))  // skip state classes
      .slice(0, 2)
      .map(c => `.${CSS.escape(c)}`)
      .join('');
    const candidate = cls ? `${tag}${cls}` : tag;

    // Build nth-child if not unique
    if (document.querySelectorAll(candidate).length === 1) return candidate;
    return buildNthChildSelector(el);
  }

  function buildNthChildSelector(el) {
    const parts = [];
    let node = el;
    while (node && node !== document.body) {
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (!parent) break;
      const siblings = Array.from(parent.children).filter(c => c.tagName === node.tagName);
      const idx = siblings.indexOf(node) + 1;
      parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${idx})` : tag);
      node = parent;
    }
    return parts.join(' > ');
  }

  function buildXPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (!parent) { parts.unshift(tag); break; }
      const siblings = Array.from(parent.children).filter(c => c.tagName === node.tagName);
      const idx = siblings.indexOf(node) + 1;
      parts.unshift(siblings.length > 1 ? `${tag}[${idx}]` : tag);
      node = parent;
    }
    return `//${parts.join('/')}`;
  }

  function getAriaLabel(el) {
    if (!el) return null;
    // aria-label attribute
    const direct = el.getAttribute('aria-label');
    if (direct) return direct;
    // aria-labelledby → look up the referenced element
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const ref = document.getElementById(labelledBy);
      if (ref) return ref.textContent.trim();
    }
    // <label for="id">
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) return label.textContent.trim();
    }
    // role + text content (buttons, links)
    const role = el.getAttribute('role') || el.tagName.toLowerCase();
    const text = el.textContent?.trim();
    if (['button','link','menuitem','tab'].includes(role) && text && text.length < 60) return text;
    return null;
  }

  function generateSelectors(el) {
    if (!el || el === document || el === document.body) return [];
    const selectors = [];

    const aria = getAriaLabel(el);
    if (aria) selectors.push([`aria/${aria}`]);

    const css = buildCSSSelector(el);
    if (css) selectors.push([css]);

    const xpath = buildXPath(el);
    if (xpath) selectors.push([`xpath/${xpath}`]);

    const text = el.textContent?.trim();
    if (text && text.length > 0 && text.length < 50 && !['INPUT','TEXTAREA','SELECT'].includes(el.tagName)) {
      selectors.push([`text/${text}`]);
    }

    return selectors;
  }

  function getFrameIndex() {
    // Determine the index of this frame within its parent's child frames
    if (window === window.top) return [];
    try {
      const frames = Array.from(window.parent.frames);
      const idx = frames.indexOf(window);
      return idx >= 0 ? [idx] : [];
    } catch (_) {
      return [];
    }
  }

  const frameInfo = getFrameIndex().length > 0 ? { frame: getFrameIndex() } : {};

  // ── Event Handlers ────────────────────────────────────────────────────────────

  function handleClick(e) {
    const el = e.target;
    if (!el || el.tagName === 'HTML' || el.tagName === 'BODY') return;

    // Skip clicks that are part of a copy context menu (contextmenu handles those)
    const rect = el.getBoundingClientRect();
    const offsetX = Math.round(e.clientX - rect.left);
    const offsetY = Math.round(e.clientY - rect.top);

    sendStep({
      type: 'click',
      target: 'main',
      selectors: generateSelectors(el),
      offsetX: Math.max(0, offsetX),
      offsetY: Math.max(0, offsetY),
      ...frameInfo,
    });
  }

  // Track text selection (mouseup fires after selection is complete)
  function handleMouseUp(e) {
    const sel = window.getSelection()?.toString() ?? '';
    if (sel.length > 0) {
      lastSelection = sel;
      lastSelectionEl = e.target;
    }
  }

  // Debounce input → fire step on change/blur instead of every keystroke
  function handleInput(e) {
    const el = e.target;
    if (!el || !['INPUT','TEXTAREA'].includes(el.tagName)) return;
    pendingInputChange = { el, value: el.value };
  }

  function handleChange(e) {
    const el = e.target;
    if (!el) return;

    // If we had a pending input change, use the latest value
    const value = pendingInputChange?.el === el ? el.value : (el.value ?? '');
    pendingInputChange = null;

    sendStep({
      type: 'change',
      target: 'main',
      selectors: generateSelectors(el),
      value,
      ...frameInfo,
    });
  }

  // Blur fallback for autocomplete inputs: many autocomplete libraries set
  // .value programmatically without dispatching a native `change` event.
  // When the input loses focus and there's still a pending change, flush it
  // after a short delay to let the autocomplete library update the value first.
  function handleBlur(e) {
    const el = e.target;
    if (!el || !['INPUT', 'TEXTAREA'].includes(el.tagName)) return;
    if (!pendingInputChange || pendingInputChange.el !== el) return;

    const capturedEl = el;
    setTimeout(() => {
      // If handleChange already fired (change event arrived within the delay), skip.
      if (!pendingInputChange || pendingInputChange.el !== capturedEl) return;
      const value = capturedEl.value ?? '';
      pendingInputChange = null;
      sendStep({
        type: 'change',
        target: 'main',
        selectors: generateSelectors(capturedEl),
        value,
        ...frameInfo,
      });
    }, 200);
  }

  // Copy event — covers Ctrl+C, Cmd+C, and right-click → Copy
  function handleCopy(_e) {
    const sel = window.getSelection()?.toString() ?? lastSelection ?? '';
    const activeEl = document.activeElement;

    let copiedText = sel;
    // If nothing selected globally, try the active input's selection
    if (!copiedText && activeEl && ['INPUT','TEXTAREA'].includes(activeEl.tagName)) {
      copiedText = activeEl.value.slice(activeEl.selectionStart, activeEl.selectionEnd);
      if (!copiedText) copiedText = activeEl.value;  // fallback: whole value
    }

    const varName = `clipboard_${Date.now()}`;
    lastCopiedVarName = varName;

    sendStep({
      type: 'copy',
      target: 'main',
      variableName: varName,
      snapshotValue: copiedText,
      selectors: generateSelectors(activeEl || lastSelectionEl),
      ...frameInfo,
    });

    // Reset selection tracking
    lastSelection = '';
    lastSelectionEl = null;
  }

  // Paste event — Ctrl+V, Cmd+V, and right-click → Paste
  function handlePaste(_e) {
    const el = document.activeElement;
    sendStep({
      type: 'paste',
      target: 'main',
      variableName: lastCopiedVarName,
      selectors: generateSelectors(el),
      ...frameInfo,
    });
  }

  // Keyboard events — only record non-trivial keys (exclude individual char keys
  // since those are captured by the change/input handlers)
  const SPECIAL_KEYS = new Set([
    'Enter','Tab','Escape','Backspace','Delete','ArrowUp','ArrowDown','ArrowLeft','ArrowRight',
    'Home','End','PageUp','PageDown','F1','F2','F3','F4','F5','F6','F7','F8','F9','F10','F11','F12',
    'Meta','Control','Alt','Shift',
  ]);

  function handleKeyDown(e) {
    // Clipboard shortcuts are handled by copy/paste events — skip them here
    if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'v' || e.key === 'x')) return;

    // Only record modifier combos or special keys
    if (!SPECIAL_KEYS.has(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) return;

    sendStep({ type: 'keyDown', target: 'main', key: e.key, ...frameInfo });
  }

  function handleKeyUp(e) {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'v' || e.key === 'x')) return;
    if (!SPECIAL_KEYS.has(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) return;
    sendStep({ type: 'keyUp', target: 'main', key: e.key, ...frameInfo });
  }

  // Right-click: send the element info directly to the SW via message.
  // Using a message is more reliable than window.__lastContextMenuEl because
  // a later executeScript call runs in a different execution context in MV3.
  function handleContextMenu(e) {
    const el = e.target;
    if (!el || el.tagName === 'HTML' || el.tagName === 'BODY') return;
    const rect = el.getBoundingClientRect();

    // Capture element's current text/value so the SW can use it as a default
    // for the "Save variable" dialog without needing another executeScript round-trip.
    let elementValue = '';
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) {
      elementValue = el.value ?? '';
    } else {
      elementValue = el.textContent?.trim() ?? '';
    }

    try {
      chrome.runtime.sendMessage({
        type: 'STORE_CONTEXT_EL',
        payload: {
          selectors: generateSelectors(el),
          offsetX: Math.max(0, Math.round(e.clientX - rect.left)),
          offsetY: Math.max(0, Math.round(e.clientY - rect.top)),
          frame: getFrameIndex(),
          elementValue: elementValue.slice(0, 200),
        },
      });
    } catch (_) {
      // Extension context invalidated — ignore.
    }
  }

  // ── Register listeners ────────────────────────────────────────────────────────
  // Note: navigate steps are recorded by the service worker via webNavigation.onDOMContentLoaded,
  // which captures the correct destination URL. beforeunload is not used here.
  document.addEventListener('click',       handleClick,       { capture: true });
  document.addEventListener('mouseup',     handleMouseUp,     { capture: true });
  document.addEventListener('input',       handleInput,       { capture: true });
  document.addEventListener('change',      handleChange,      { capture: true });
  document.addEventListener('blur',        handleBlur,        { capture: true });
  document.addEventListener('copy',        handleCopy,        { capture: true });
  document.addEventListener('paste',       handlePaste,       { capture: true });
  document.addEventListener('keydown',     handleKeyDown,     { capture: true });
  document.addEventListener('keyup',       handleKeyUp,       { capture: true });
  document.addEventListener('contextmenu', handleContextMenu, { capture: true });

  // ── Cleanup function (called by service worker on stop/abort) ─────────────────
  window.__recorderCleanup = function () {
    document.removeEventListener('click',       handleClick,       { capture: true });
    document.removeEventListener('mouseup',     handleMouseUp,     { capture: true });
    document.removeEventListener('input',       handleInput,       { capture: true });
    document.removeEventListener('change',      handleChange,      { capture: true });
    document.removeEventListener('blur',        handleBlur,        { capture: true });
    document.removeEventListener('copy',        handleCopy,        { capture: true });
    document.removeEventListener('paste',       handlePaste,       { capture: true });
    document.removeEventListener('keydown',     handleKeyDown,     { capture: true });
    document.removeEventListener('keyup',       handleKeyUp,       { capture: true });
    document.removeEventListener('contextmenu', handleContextMenu, { capture: true });
    window.__lastContextMenuEl = null;
    window.__recorderActive = false;
    window.__recorderCleanup = null;
  };
})();
