import { resolveObjectId, scrollIntoViewAndGetRect, sleep } from "./helpers.js";

// ── copy ───────────────────────────────────────────────────────────────────────

export async function execCopyVariableAtRecording(
  step,
  tabId,
  contextId,
  clipboardVars,
  cdp
) {
  // Mirror the recording logic exactly:
  // 1. window.getSelection() — highlighted text or right-click word selection
  // 2. selectionStart/selectionEnd for inputs/textareas — only the selected portion
  // 3. Never grab the full value or textContent
  // 4. Fall back to snapshotValue (what was literally selected at record time)
  const objectId = await resolveObjectId(step.selectors, tabId, contextId, cdp);
  console.log(
    `[Copy] var="${step.variableName}" objectId=${objectId ? "found" : "NOT FOUND"} selectors=`,
    JSON.stringify(step.selectors)
  );
  if (!objectId)
    throw new Error(
      `copy: could not find element for variable "${step.variableName}". Tried: ${JSON.stringify(step.selectors)}`
    );

  const res = await cdp(tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function(snapshotValue) {
      // For inputs/textareas: find snapshotValue in the value and select that range.
      if (this.tagName === 'INPUT' || this.tagName === 'TEXTAREA') {
        if (snapshotValue) {
          const idx = this.value.indexOf(snapshotValue);
          if (idx !== -1) {
            this.focus();
            this.setSelectionRange(idx, idx + snapshotValue.length);
            return snapshotValue;
          }
        }
        return this.value.slice(this.selectionStart, this.selectionEnd);
      }
      // For text nodes: find snapshotValue in the element's text and select it,
      // mirroring what the browser does when the user right-clicks on a word.
      if (snapshotValue) {
        const walker = document.createTreeWalker(this, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          const idx = node.textContent.indexOf(snapshotValue);
          if (idx !== -1) {
            const range = document.createRange();
            range.setStart(node, idx);
            range.setEnd(node, idx + snapshotValue.length);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            return snapshotValue;
          }
        }
      }
      // Fall through to whatever is currently selected.
      return window.getSelection()?.toString() ?? "";
    }`,
    arguments: [{ value: step.snapshotValue ?? "" }],
    returnByValue: true
  }).catch(console.error);

  const liveCapture = res?.result?.value ?? "";
  const captured = liveCapture || step.snapshotValue || "";
  console.log(
    `[Copy] var="${step.variableName}" liveCapture="${liveCapture}" snapshotValue="${step.snapshotValue}" using="${captured}"`
  );
  if (!captured)
    throw new Error(
      `copy: element found but nothing was selected for variable "${step.variableName}"`
    );

  clipboardVars.set(step.variableName, captured);
}

// ── paste ──────────────────────────────────────────────────────────────────────

export async function execPasteVariableAtRecording(
  step,
  tabId,
  contextId,
  clipboardVars,
  cdp
) {
  const textToPaste = clipboardVars.get(step.variableName);
  console.log(`[Paste] var="${step.variableName}" value="${textToPaste}"`);
  if (!textToPaste)
    throw new Error(
      `paste: no runtime value found for variable "${step.variableName}" — make sure a copy step ran before this`
    );

  const objectId = await resolveObjectId(step.selectors, tabId, contextId, cdp);
  if (!objectId)
    throw new Error(
      `Could not resolve paste target. Tried: ${JSON.stringify(step.selectors)}`
    );

  await pasteTextIntoElement(objectId, textToPaste, tabId, cdp);
}

// ── copyVariable (captures live value at replay time) ──────────────────────────

export async function execCopyVariableAtReplaying(
  step,
  tabId,
  contextId,
  cdp,
  variables
) {
  const suffix = variables.get("__replaySuffix__") ?? "";
  const varKey = suffix ? `${step.variableName}-${suffix}` : step.variableName;

  // ── 1. Pattern scan (primary for dynamic values) ─────────────────────────
  // Try the RegExp pattern first — it matches the structure of the value
  // regardless of what the actual content is at replay time.
  if (step.valuePattern) {
    console.log(
      `[CopyVariable] trying pattern "${step.valuePattern}" on tag "${step.elementTag}"`
    );
    const patternRes = await cdp(tabId, "Runtime.evaluate", {
      expression: `(function() {
        const pattern = new RegExp(${JSON.stringify(step.valuePattern)});
        const tag = ${JSON.stringify(step.elementTag || "")};
        const tags = tag ? [tag] : ['a','td','span','div','p','li'];
        for (const t of tags) {
          for (const el of document.querySelectorAll(t)) {
            if (el.offsetParent === null) continue;
            const text = (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')
              ? el.value
              : el.textContent?.trim() ?? '';
            if (text && pattern.test(text)) return text;
          }
        }
        return null;
      })()`,
      returnByValue: true,
      ...(contextId ? { contextId } : {})
    }).catch(console.error);

    const patternValue = patternRes?.result?.value;
    if (patternValue) {
      console.log(`[CopyVariable] pattern match: "${patternValue}" → stored as key="${varKey}"`);
      variables.set(varKey, patternValue);
      return;
    }
    console.log(`[CopyVariable] pattern scan found nothing — falling back to selectors`);
  }

  // ── 2. Selector-based fallback ────────────────────────────────────────────
  const objectId = await resolveObjectId(step.selectors, tabId, contextId, cdp);
  console.log(
    `[CopyVariable] var="${step.variableName}" objectId=${objectId ? "found" : "NOT FOUND"} selectors=`,
    JSON.stringify(step.selectors)
  );

  if (!objectId)
    throw new Error(
      `copyVariable: could not find element for variable "${step.variableName}". Tried: ${JSON.stringify(step.selectors)}`
    );

  const res = await cdp(tabId, "Runtime.callFunctionOn", {
    objectId,
    // copyVariable captures the live text content of the element at replay time —
    // not a user selection. Read value for form fields, textContent for everything else.
    functionDeclaration: `function() {
      if (this.tagName === 'INPUT' || this.tagName === 'TEXTAREA' || this.tagName === 'SELECT') {
        return this.value;
      }
      return this.textContent?.trim() ?? '';
    }`,
    returnByValue: true
  });

  const liveCapture = res?.result?.value ?? "";
  const value = liveCapture || step.defaultValue || "";
  console.log(
    `[CopyVariable] var="${step.variableName}" liveCapture="${liveCapture}" defaultValue="${step.defaultValue}" using="${value}"`
  );
  if (!value)
    throw new Error(
      `copyVariable: element found but text content is empty for variable "${step.variableName}"`
    );

  variables.set(varKey, value);
  console.log(`[CopyVariable] stored as key="${varKey}"`);
}

// ── pasteVariable (uses value copied at replay time) ───────────────────────────

export async function execPasteVariableAtReplaying(
  step,
  tabId,
  contextId,
  cdp,
  variables
) {
  const suffix = variables.get("__replaySuffix__") ?? "";
  const varKey = suffix ? `${step.variableName}-${suffix}` : step.variableName;
  const textToPaste = variables.get(varKey);
  console.log(
    `[PasteVariable] var="${step.variableName}" key="${varKey}" value="${textToPaste}"`
  );
  if (!textToPaste)
    throw new Error(
      `pasteVariable: no runtime value found for key "${varKey}" — make sure a copyVariable step ran before this`
    );

  const objectId = await resolveObjectId(step.selectors, tabId, contextId, cdp);
  if (!objectId)
    throw new Error(
      `Could not resolve paste target. Tried: ${JSON.stringify(step.selectors)}`
    );

  await pasteTextIntoElement(objectId, textToPaste, tabId, cdp);
}

// ── pasteTextIntoElement ────────────────────────────────────────────────────────
//
// Shared paste logic used by both paste step variants.
//
// The key problem with LWC shadow-DOM inputs (and type="search" in particular):
// Runtime.callFunctionOn → this.focus() goes through LWC's synthetic event system
// and does NOT transfer real keyboard focus to the element.  Input.insertText then
// goes to whatever happened to be focused before, producing no visible output.
//
// Fix: use CDP mouse events (same path as execClick) to give the element real focus,
// then insert text, then fire input/change/keydown so search/autocomplete listeners
// (aria-controls="suggestionsList-…") actually trigger.
//
async function pasteTextIntoElement(objectId, textToPaste, tabId, cdp) {
  // 1. Scroll into view so the element is visible (required before DOM.focus).
  await scrollIntoViewAndGetRect(objectId, tabId, cdp);

  // 2. Use CDP DOM.focus — focuses the exact node by objectId without needing
  //    coordinates. Unlike JS this.focus() it bypasses LWC's synthetic event
  //    system and gives the element real keyboard focus. Unlike dispatchMouse
  //    it cannot accidentally hit a different element (e.g. a nearby link).
  await cdp(tabId, "DOM.focus", { objectId }).catch((e) => {
    console.error(e);
    // Fallback for elements that don't accept DOM.focus (e.g. non-focusable divs)
    return cdp(tabId, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: "function() { this.focus(); }",
      returnByValue: true
    }).catch(console.error);
  });
  await sleep(80);

  // 3. Clear the current value.
  await cdp(tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: 'function() { this.select(); this.value = ""; }',
    returnByValue: true
  }).catch(console.error);

  // 4. Insert text — works because DOM.focus gave the element real keyboard focus.
  await cdp(tabId, "Input.insertText", { text: textToPaste });

  // 5. Ensure value is set and fire all relevant events so search/autocomplete
  //    listeners (input, change, keydown) pick up the new value.
  //    For type="search" inputs (e.g. Salesforce LWC global search), dispatching
  //    'change' dismisses the results panel (aria-hidden while focused → O11Y error).
  //    Only fire 'input' for those, same as execChange's isSearchInput handling.
  await cdp(tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function(v) {
      if (this.value !== v) this.value = v;
      const isSearch = this.type === 'search';
      this.dispatchEvent(new Event('input', { bubbles: true }));
      if (!isSearch) {
        this.dispatchEvent(new Event('change', { bubbles: true }));
      }
      this.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true }));
      this.dispatchEvent(new KeyboardEvent('keyup',   { bubbles: true, cancelable: true }));
    }`,
    arguments: [{ value: textToPaste }],
    returnByValue: true
  });
}
