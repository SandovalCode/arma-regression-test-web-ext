import { resolveObjectId, scrollIntoViewAndGetRect, sleep } from "./helpers.js";

// ── copy ───────────────────────────────────────────────────────────────────────

export async function execCopyVariableAtRecording(
  step,
  tabId,
  contextId,
  clipboardVars,
  cdp
) {
  // Read directly from the recorded element — window.getSelection() is unreliable
  // at replay time (no human interaction) and can pick up stray selected text left
  // by previous CDP clicks (e.g. "Basic Search" link text).
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
    functionDeclaration: `function() {
      if (this.tagName === 'INPUT' || this.tagName === 'TEXTAREA' || this.tagName === 'SELECT') {
        return this.value;
      }
      return this.textContent?.trim() ?? '';
    }`,
    returnByValue: true
  }).catch(console.error);

  const captured = res?.result?.value ?? "";
  console.log(`[Copy] var="${step.variableName}" captured="${captured}"`);
  if (!captured)
    throw new Error(
      `copy: element found but value is empty for variable "${step.variableName}"`
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
    functionDeclaration: `function() {
      if (this.tagName === 'INPUT' || this.tagName === 'TEXTAREA' || this.tagName === 'SELECT') {
        return this.value;
      }
      return this.textContent?.trim() ?? '';
    }`,
    returnByValue: true
  });

  const value = res?.result?.value;
  console.log(`[CopyVariable] var="${step.variableName}" captured="${value}"`);
  if (!value)
    throw new Error(
      `copyVariable: element found but value is empty for variable "${step.variableName}"`
    );

  const suffix = variables.get("__replaySuffix__") ?? "";
  const varKey = suffix ? `${step.variableName}-${suffix}` : step.variableName;
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
