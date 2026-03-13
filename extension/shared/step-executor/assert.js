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
export async function execAssertNotPresent(step, tabId, contextId, cdp, frameContextMap = new Map()) {
  const selector = step.selector ?? "";
  const textContent = (step.textContent ?? "").trim();
  const label = step.title ? `"${step.title}"` : `selector "${selector}"`;

  if (!selector) throw new Error(`assertNotPresent: no selector provided for ${label}`);

  // Search the full page: main DOM + all shadow roots recursively.
  // Also checks document.documentElement.outerHTML as a raw string fallback.
  const expression = `(function () {
    var selector = ${JSON.stringify(selector)};
    var needle = ${JSON.stringify(textContent)};

    function queryAll(root) {
      var found = [];
      try { found = Array.from(root.querySelectorAll(selector)); } catch (e) {}
      try {
        var hosts = root.querySelectorAll("*");
        for (var i = 0; i < hosts.length; i++) {
          if (hosts[i].shadowRoot) found = found.concat(queryAll(hosts[i].shadowRoot));
        }
      } catch (e) {}
      return found;
    }

    var elements = queryAll(document);
    if (elements.length > 0) {
      if (!needle) return true;
      if (elements.some(function (el) { return (el.textContent || "").trim() === needle; })) return true;
    }

    try {
      var html = document.documentElement ? document.documentElement.outerHTML : "";
      if (html && selector && !selector.includes(" ") && !selector.includes(">")) {
        var plain = selector.replace(/^[a-z][a-z0-9-]*/, "");
        if (plain.startsWith("#")) {
          var id = plain.slice(1).replace(/\\.(.)/g, "$1");
          if (html.includes('id="' + id + '"') || html.includes("id='" + id + "'")) return true;
        }
        var classMatches = plain.match(/\\.([^.#[\\s>~+]+)/g);
        if (classMatches) {
          var cls = classMatches[0].slice(1).replace(/\\.(.)/g, "$1");
          if (html.includes('class="' + cls + '"') || html.includes(cls)) return true;
        }
      }
      if (needle && html.includes(needle)) return true;
    } catch (e) {}

    return false;
  })()`;

  // Check main frame first (no contextId), then every known iframe context.
  // assertNotPresent must pass in ALL frames — if the element appears anywhere, fail.
  const contextsToCheck = new Set([null]);
  if (contextId) contextsToCheck.add(contextId);
  for (const [, ctxId] of frameContextMap) {
    if (ctxId) contextsToCheck.add(ctxId);
  }

  for (const ctxId of contextsToCheck) {
    const params = { expression, returnByValue: true };
    if (ctxId) params.contextId = ctxId;
    const res = await cdp(tabId, "Runtime.evaluate", params).catch(() => null);
    if (res?.result?.value === true) {
      throw new Error(`Assertion failed: element ${label} was found but should not be present on the page`);
    }
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
