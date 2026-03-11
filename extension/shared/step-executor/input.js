import { STEP_TIMEOUT_MS } from "../constants.js";
import {
  resolveObjectId,
  dispatchMouse,
  scrollIntoViewAndGetRect,
  sleep
} from "./helpers.js";

// ── change (text input, select) ────────────────────────────────────────────────

export async function execChange(step, tabId, contextId, cdp) {
  const value = step.value ?? "";

  const objectId = await resolveObjectId(step.selectors, tabId, contextId, cdp);
  if (!objectId)
    throw new Error(
      `Could not resolve element for change step. Tried: ${JSON.stringify(step.selectors)}`
    );

  const tagRes = await cdp(tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration:
      'function() { return { tag: this.tagName, cls: this.className ?? "", inputType: this.type ?? "", name: this.name ?? "" }; }',
    returnByValue: true
  });
  const {
    tag: tagName = "",
    cls: className = "",
    inputType = "",
    name: elementName = ""
  } = tagRes?.result?.value ?? {};

  // Radio buttons and checkboxes: the click step already checked them.
  // If an old recording has a spurious change step for one, just ensure it's
  // checked and fire the events — never use Input.insertText on these.
  if (inputType === "radio" || inputType === "checkbox") {
    await cdp(tabId, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function() {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'checked'
        )?.set;
        if (setter) setter.call(this, true);
        this.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        this.dispatchEvent(new Event('input',  { bubbles: true, cancelable: true }));
      }`,
      returnByValue: true
    }).catch(console.error);
    return;
  }

  // A step recorded from a <select> always has step.label set
  const isSelectStep = tagName === "SELECT" || step.label !== undefined;

  // Custom autocomplete inputs (class contains "autocomplete") get the full value
  // inserted directly, EXCEPT entity-lookup fields whose name ends with "_id_hc"
  // (e.g. cl_id_hc, us_id_hc). Those drive an AJAX partial-search endpoint that
  // returns candidates from a prefix query, so only the first 10 chars are typed
  // to trigger the dropdown; tryClickAutocompleteOption then clicks the right result.
  const isAutocompleteInput = className.split(/\s+/).includes("autocomplete");
  const isPartialSearchAutocomplete =
    isAutocompleteInput &&
    elementName.toLowerCase().endsWith("_id_hc") &&
    !elementName.toLowerCase().includes("address");

  // Search inputs (type="search") drive a live search panel that must remain open
  // for the next step to click a result. Dispatching blur or change causes the panel
  // to dismiss with aria-hidden while focus is still inside, triggering Salesforce's
  // O11Y error dialog. For these inputs, only fire 'input' to trigger the search
  // reactivity and leave the panel open — the subsequent click step closes it naturally.
  const isSearchInput = inputType === "search";

  if (isSelectStep) {
    // Wait for the target option to exist — selects may load options via AJAX
    // (e.g. serv_id). Re-resolves on each poll so stale objectIds after a DOM
    // replacement don't hang the loop. Returns the fresh live objectId.
    const readyId =
      (await waitForOption(step.selectors, value, tabId, contextId, cdp)) ??
      objectId;

    let cx, cy;
    const selectBox = await scrollIntoViewAndGetRect(readyId, tabId, cdp);
    if (selectBox) {
      cx = selectBox.x + selectBox.width / 2;
      cy = selectBox.y + selectBox.height / 2;
    }

    // 1. mouseenter via CDP (mouseMoved does NOT open the OS-level dropdown)
    if (cx != null) {
      await dispatchMouse(tabId, "mouseMoved", cx, cy, "none", 0, cdp);
      await sleep(80);
    }

    // 2. click (synthetic JS) → 3. focus → 4. value → 5. change → 6. blur
    // Synthetic MouseEvent fires click listeners without opening the OS dropdown,
    // which would block subsequent JS for plain native selects (e.g. serv_id).
    await cdp(tabId, "Runtime.callFunctionOn", {
      objectId: readyId,
      functionDeclaration: `function() {
        this.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        this.focus();
        this.value = ${JSON.stringify(value)};
        this.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        this.dispatchEvent(new Event('blur',   { bubbles: true }));
        this.blur();
      }`,
      returnByValue: true
    });

  } else if (isSearchInput) {
    // type="search" inputs (e.g. Salesforce LWC global search) drive a live results
    // panel that must stay open. Rules:
    //   1. Do NOT clear the field — it starts fresh and clearing collapses the panel.
    //   2. Use DOM.focus (bypasses LWC synthetic focus) so Input.insertText lands here.
    //   3. Fire only 'input' — blur/change dismisses the panel (aria-hidden + O11Y error).
    await cdp(tabId, "DOM.focus", { objectId }).catch(() =>
      cdp(tabId, "Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: "function() { this.focus(); }",
        returnByValue: true
      })
    );
    await sleep(80);
  } else {
    // Use DOM.focus (real CDP keyboard focus) so Input.insertText lands on this element,
    // then clear any existing value before typing.
    await cdp(tabId, "DOM.focus", { objectId }).catch(() =>
      cdp(tabId, "Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: "function() { this.focus(); }",
        returnByValue: true
      })
    );
    await sleep(80);
    await cdp(tabId, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: 'function() { this.select(); this.value = ""; }',
      returnByValue: true
    });

    if (value) {
      await cdp(tabId, "Input.insertText", {
        text: isPartialSearchAutocomplete ? value.slice(0, 10) : value
      });
    }

    if (isAutocompleteInput) {
      // Auto complete input, for Valex
      // Avalex-style autocomplete (class contains "autocomplete"): fire input + change +
      // keydown to trigger the AJAX dropdown, then tryClickAutocompleteOption clicks the
      // result. Must NOT blur before tryClickAutocompleteOption — blur closes the dropdown.
      await cdp(tabId, "Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function() {
          this.dispatchEvent(new Event('input',  { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
          this.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
        }`,
        returnByValue: true
      });
    } else {
      // Regular inputs: blur before change matches real browser event order
      // (input → blur → change). Without blur first, frameworks like Salesforce Aura/LWC
      await cdp(tabId, "Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function() {
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.blur();
          this.dispatchEvent(new Event('change', { bubbles: true }));
        }`,
        returnByValue: true
      });
    }
    await tryClickAutocompleteOption(value, tabId, contextId, cdp);
  }
}

// ── selectOption ───────────────────────────────────────────────────────────────
//
// Treat <select> as a plain HTML form field — no mouse simulation needed.
//
//  1. Custom dropdown libraries (Select2, Chosen…) render their own DOM —
//     click the visible option element directly.
//  2. Native select: inject the option if missing, set select.value, then
//     register a capture-phase submit listener so the value survives any AJAX
//     that might reset the select before form submission.

export async function execSelectOption(step, tabId, contextId, cdp) {
  // Build a selector list that puts "select[...]" CSS selectors FIRST.
  // Plain #id selectors can match a hidden <input id="serv_id"> instead of
  // the actual <select name="serv_id">, causing "options is not iterable".
  const normalized = Array.isArray(step.selectors[0])
    ? step.selectors
    : step.selectors.map((s) => [s]);
  const selectFirst = [
    ...normalized.filter((c) => (c[0] ?? "").startsWith("select")),
    ...normalized.filter((c) => !(c[0] ?? "").startsWith("select"))
  ];

  const objectId = await resolveObjectId(selectFirst, tabId, contextId, cdp);
  if (!objectId)
    throw new Error(
      `selectOption: could not find select. Tried: ${JSON.stringify(selectFirst)}`
    );

  await scrollIntoViewAndGetRect(objectId, tabId, cdp);

  // 1. Custom dropdown: if a library rendered visible option elements, click one.
  const label = step.label ?? step.value;
  const optCoords = await findVisibleOptionCoords(
    label,
    step.value,
    tabId,
    contextId,
    cdp
  );
  if (optCoords) {
    await dispatchMouse(
      tabId,
      "mouseMoved",
      optCoords.x,
      optCoords.y,
      "none",
      0,
      cdp
    );
    await sleep(50);
    await dispatchMouse(
      tabId,
      "mousePressed",
      optCoords.x,
      optCoords.y,
      "left",
      1,
      cdp
    );
    await dispatchMouse(
      tabId,
      "mouseReleased",
      optCoords.x,
      optCoords.y,
      "left",
      1,
      cdp
    );
    return;
  }

  // 2. Native select — pure form-field approach.
  //
  //    Problem: AJAX triggered by other steps can replace the options list at
  //    any time, resetting the select back to a default value (e.g. "10").
  //    Solution: set the value immediately AND register a capture-phase submit
  //    listener on the form that re-applies the value right before submission —
  //    no AJAX running after the button click can undo this.
  const setRes = await cdp(tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function() {
      const v = ${JSON.stringify(step.value)};
      const l = ${JSON.stringify(label)};
      const sel = this;

      function applyValue() {
        if (![...sel.options].some(o => o.value === v)) {
          sel.add(new Option(l, v, true, true));
        }
        sel.value = v;
      }

      applyValue();

      // Register a capture-phase submit handler so the value is guaranteed
      // correct at the moment the browser serializes form data, even if AJAX
      // resets the select between now and the Submit click.
      const form = sel.form || sel.closest('form');
      if (form && !form.__botSelectHandlers) form.__botSelectHandlers = {};
      if (form && !form.__botSelectHandlers[sel.name]) {
        form.__botSelectHandlers[sel.name] = applyValue;
        form.addEventListener('submit', applyValue, true);
      }

      return sel.value;
    }`,
    returnByValue: true
  });
  if (setRes?.exceptionDetails) {
    console.warn(
      `[selectOption] exception:`,
      JSON.stringify(setRes.exceptionDetails)
    );
  }
}

/**
 * After a dropdown is opened, scan the DOM for a visible element whose text
 * matches the option label (or whose data-value matches the option value).
 * Works for Select2, Chosen, Tom-Select, and other custom dropdown libraries.
 * Returns { x, y } viewport coordinates to click, or null for native selects.
 */
async function findVisibleOptionCoords(
  labelText,
  value,
  tabId,
  contextId,
  cdp
) {
  const expr = `
    (function() {
      const label = ${JSON.stringify(String(labelText))};
      const val   = ${JSON.stringify(String(value))};
      const SELECTORS = [
        '[role="option"]',
        '[role="listbox"] li', '[role="listbox"] div',
        '.select2-results__option',
        '.chosen-results .active-result',
        '.ts-dropdown .option',
        'ul[class*="dropdown"] li',
        'div[class*="dropdown"] [class*="item"]',
        'li[class*="option"]',
        'div[class*="option"]',
      ];
      for (const sel of SELECTORS) {
        for (const el of document.querySelectorAll(sel)) {
          const text = (el.textContent || '').trim();
          if (text !== label && el.dataset?.value !== val) continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
      }
      return null;
    })()
  `;
  const params = { expression: expr, returnByValue: true };
  if (contextId) params.contextId = contextId;
  const res = await cdp(tabId, "Runtime.evaluate", params).catch(console.error);
  return res?.result?.value ?? null;
}

// ── Autocomplete option picker ──────────────────────────────────────────────────

async function tryClickAutocompleteOption(targetText, tabId, contextId, cdp) {
  const result = await cdp(tabId, "Runtime.evaluate", {
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

        const seen = new Set();
        const candidates = [];
        for (const sel of selectors) {
          for (const el of document.querySelectorAll(sel)) {
            if (!seen.has(el)) { seen.add(el); candidates.push(el); }
          }
        }

        for (const pass of ['exact', 'partial']) {
          for (const el of candidates) {
            const text = (el.textContent ?? el.getAttribute('value') ?? '').trim();
            const matches = pass === 'exact' ? text === target : text.toLowerCase().includes(target.toLowerCase());
            if (!matches) continue;
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
    returnByValue: true
  });

  const coords = result?.result?.value;
  if (!coords) return false;

  await cdp(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: coords.x,
    y: coords.y,
    button: "none",
    clickCount: 0
  });
  await sleep(50);
  await cdp(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: coords.x,
    y: coords.y,
    button: "left",
    clickCount: 1
  });
  await cdp(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: coords.x,
    y: coords.y,
    button: "left",
    clickCount: 1
  });

  return true;
}

/**
 * Polls until the <select> has an <option> matching targetValue, or until
 * STEP_TIMEOUT_MS elapses.
 *
 * Re-resolves the element on every iteration — the DOM node is often replaced
 * when AJAX loads the options, making the original objectId stale. Calling
 * Runtime.callFunctionOn on a detached node fails silently (returns null),
 * which would cause an infinite wait if we reused the original id.
 *
 * Returns the fresh objectId of the live element, or null on timeout.
 */
async function waitForOption(
  selectors,
  targetValue,
  tabId,
  contextId,
  cdp,
  timeoutMs = STEP_TIMEOUT_MS
) {
  const deadline = Date.now() + timeoutMs;
  let consecutiveErrors = 0;

  // Build a Runtime.evaluate expression using the first usable CSS selector.
  // Avoids callFunctionOn + objectId entirely — no stale-reference or `this`-binding issues.
  const normalized = Array.isArray(selectors[0])
    ? selectors
    : selectors.map((s) => [s]);
  const cssSel = normalized.find(
    (c) => c[0] && !c[0].includes("/") && !c[0].includes(" >>> ")
  )?.[0];
  const getEl = cssSel
    ? cssSel.startsWith("#")
      ? `document.getElementById(${JSON.stringify(cssSel.slice(1))})`
      : `document.querySelector(${JSON.stringify(cssSel)})`
    : null;
  const targetStr = JSON.stringify(String(targetValue));

  while (Date.now() < deadline) {
    let found = false;

    if (getEl) {
      const expr = `(function(){
        const el=${getEl};
        if (!el) return false;
        return [...(el.options || [])].some(o => o.value === ${targetStr});
      })()`;
      const params = { expression: expr, returnByValue: true };
      if (contextId) params.contextId = contextId;

      const res = await cdp(tabId, "Runtime.evaluate", params).catch(
        console.error
      );
      if (res === null) {
        // CDP rejected — debugger likely detached
        if (++consecutiveErrors >= 6)
          throw new Error(
            `Debugger detached while waiting for <select> option "${targetValue}"`
          );
      } else {
        consecutiveErrors = 0;
        found = res?.result?.value === true;
      }
    } else {
      // No plain CSS selector — fall back to resolveObjectId + callFunctionOn
      const freshId = await resolveObjectId(selectors, tabId, contextId, cdp);
      if (!freshId) {
        if (++consecutiveErrors >= 6)
          throw new Error(
            `Debugger detached while waiting for <select> option "${targetValue}"`
          );
      } else {
        consecutiveErrors = 0;
        const res = await cdp(tabId, "Runtime.callFunctionOn", {
          objectId: freshId,
          functionDeclaration: `function(){ return [...(this.options||[])].some(o=>o.value===${targetStr}); }`,
          returnByValue: true
        }).catch(console.error);
        found = res?.result?.value === true;
      }
    }

    if (found) {
      return await resolveObjectId(selectors, tabId, contextId, cdp);
    }

    await sleep(500);
  }
  return null;
}
