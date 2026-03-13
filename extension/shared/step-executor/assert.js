/**
 * Assert that an element matching step.selector (and optionally step.textContent)
 * is NOT present in the page.
 *
 * Step shape:
 * {
 *   type: "assertNotPresent",
 *   title: string,        // human-readable label shown in error messages
 *   selector: string,     // CSS selector derived from the HTML snippet
 *   textContent: string,  // expected text content to narrow the match (may be empty)
 *   originalHtml: string, // the raw input — stored for display only
 * }
 */
export async function execAssertNotPresent(step, tabId, contextId, cdp) {
  const selector = step.selector ?? "";
  const textContent = (step.textContent ?? "").trim();
  const label = step.title ? `"${step.title}"` : `selector "${selector}"`;

  if (!selector) throw new Error(`assertNotPresent: no selector provided for ${label}`);

  const expression = textContent
    ? `(function () {
        var els = document.querySelectorAll(${JSON.stringify(selector)});
        var needle = ${JSON.stringify(textContent)};
        return Array.from(els).some(function (el) {
          return (el.textContent || "").trim() === needle;
        });
      })()`
    : `document.querySelector(${JSON.stringify(selector)}) !== null`;

  const params = { expression, returnByValue: true };
  if (contextId) params.contextId = contextId;

  const res = await cdp(tabId, "Runtime.evaluate", params);
  const found = res?.result?.value === true;

  if (found) {
    throw new Error(`Assertion failed: element ${label} was found but should not be present on the page`);
  }
}

/**
 * Assert that an element exists and has the expected value/text/checked state.
 *
 * Tries each selector candidate in order. For each, runs a single Runtime.evaluate
 * that both locates the element and reads its state — no objectId needed.
 *
 * Step shape:
 * {
 *   type: "assertElement",
 *   selectors: string[][],
 *   elementTag: string,           // "input", "select", "div", etc.
 *   elementInputType: string|null,// for <input>: "text", "checkbox", "radio", etc.
 *   expectedValue: string,        // expected value (input/select/textarea) or text content
 *   expectedChecked: bool|null,   // only for checkbox/radio
 * }
 */
export async function execAssertElement(step, tabId, contextId, cdp) {
  const selectors = (step.selectors ?? []).flat().filter(Boolean);
  if (!selectors.length) throw new Error("assertElement: no selectors provided");

  // Try each selector until the element is found
  for (const sel of selectors) {
    const getEl = sel.startsWith("#")
      ? `document.getElementById(${JSON.stringify(sel.slice(1))})`
      : `document.querySelector(${JSON.stringify(sel)})`;

    const expression = `(function () {
      var el = ${getEl};
      if (!el) return null;
      var tag = el.tagName.toLowerCase();
      var type = (el.type || "").toLowerCase();
      if (tag === "input" && (type === "checkbox" || type === "radio")) {
        return { kind: "checked", checked: el.checked, value: el.value || "" };
      }
      if (tag === "input" || tag === "textarea" || tag === "select") {
        return { kind: "value", value: el.value || "" };
      }
      return { kind: "text", text: el.textContent ? el.textContent.trim() : "" };
    })()`;

    const params = { expression, returnByValue: true };
    if (contextId) params.contextId = contextId;

    const res = await cdp(tabId, "Runtime.evaluate", params);
    const current = res?.result?.value;
    if (!current) continue; // element not found via this selector, try next

    // Element found — compare against expected values
    if (current.kind === "checked") {
      const expectedChecked = step.expectedChecked ?? false;
      if (current.checked !== expectedChecked) {
        throw new Error(
          `Assertion failed: expected ${step.elementInputType ?? "checkbox"} to be ` +
          `${expectedChecked ? "checked" : "unchecked"} but it was ` +
          `${current.checked ? "checked" : "unchecked"}`
        );
      }
    } else if (current.kind === "value") {
      const expected = step.expectedValue ?? "";
      if (current.value !== expected) {
        throw new Error(
          `Assertion failed: expected value "${expected}" but got "${current.value}"`
        );
      }
    } else {
      const expected = step.expectedValue ?? "";
      if (current.text !== expected) {
        throw new Error(
          `Assertion failed: expected text "${expected}" but got "${current.text}"`
        );
      }
    }
    return; // assertion passed
  }

  throw new Error(`assertElement: element not found. Tried: ${selectors.join(", ")}`);
}
