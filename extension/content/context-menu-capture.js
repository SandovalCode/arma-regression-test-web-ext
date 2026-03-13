// Always-on context-menu capture — sends STORE_CONTEXT_EL so
// "Add absence check" works even when no recording is active.
// Guards against double-firing when recorder.js is also injected.
if (!window.__contextMenuCaptureActive) {
  window.__contextMenuCaptureActive = true;

  // ── Selector generation (mirrors recorder.js) ─────────────────────────────

  function isSalesforce() {
    return /\.(force|salesforce|visualforce)\.com$/.test(location.hostname);
  }

  const INJECTED_ATTR_PREFIXES = ["data-dashlane-", "data-lastpass-", "data-1p-"];
  const SKIP_DATA_ATTRS = new Set([
    "data-aura-rendered-by",
    "data-ownerid",
    "data-recordid"
  ]);

  function buildSegmentInRoot(el, root) {
    const tag = el.tagName.toLowerCase();
    if (el.id) {
      const sel = `#${CSS.escape(el.id)}`;
      try {
        if ((root.querySelectorAll?.(sel) ?? []).length === 1) return sel;
      } catch (_) {}
    }
    for (const attr of el.attributes) {
      if (!attr.name.startsWith("data-") || !attr.value) continue;
      if (INJECTED_ATTR_PREFIXES.some((p) => attr.name.startsWith(p))) continue;
      if (SKIP_DATA_ATTRS.has(attr.name)) continue;
      if (/^lwc-/.test(attr.name)) continue;
      const sel = `${tag}[${attr.name}="${CSS.escape(attr.value)}"]`;
      try {
        if ((root.querySelectorAll?.(sel) ?? []).length === 1) return sel;
        if (attr.name === "data-refid") return sel;
      } catch (_) {}
    }
    const cls = Array.from(el.classList)
      .filter((c) => !/\b(active|focus|hover|selected|slds-is-open)\b/.test(c))
      .slice(0, 2)
      .map((c) => `.${CSS.escape(c)}`)
      .join("");
    const candidate = cls ? `${tag}${cls}` : tag;
    try {
      if ((root.querySelectorAll?.(candidate) ?? []).length === 1) return candidate;
    } catch (_) {}
    const parent = el.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        (c) => c.tagName === el.tagName
      );
      const idx = siblings.indexOf(el) + 1;
      return siblings.length > 1 ? `${tag}:nth-of-type(${idx})` : tag;
    }
    return tag;
  }

  function buildShadowPierceChain(el) {
    const segments = [];
    let current = el;
    while (current && current !== document.documentElement && current !== document.body) {
      const root = current.getRootNode();
      const segment = buildSegmentInRoot(current, root);
      if (!segment) break;
      segments.unshift(segment);
      if (root instanceof ShadowRoot) {
        current = root.host;
      } else {
        break;
      }
    }
    return segments.length > 1 ? segments.join(" >>> ") : null;
  }

  function buildNthChildSelector(el) {
    const parts = [];
    let node = el;
    while (node && node !== document.body) {
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (!parent) break;
      const siblings = Array.from(parent.children).filter(
        (c) => c.tagName === node.tagName
      );
      const idx = siblings.indexOf(node) + 1;
      parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${idx})` : tag);
      node = parent;
    }
    return parts.join(" > ");
  }

  function buildCSSSelector(el) {
    if (!el || el === document.body) return null;
    const root = el.getRootNode();
    const qsAll = (sel) => {
      try {
        return (root.querySelectorAll?.(sel) ?? document.querySelectorAll(sel)).length;
      } catch (_) {
        return 0;
      }
    };
    if (el.id) return `#${CSS.escape(el.id)}`;
    for (const attr of el.attributes) {
      if (!attr.name.startsWith("data-") || !attr.value) continue;
      if (INJECTED_ATTR_PREFIXES.some((p) => attr.name.startsWith(p))) continue;
      if (SKIP_DATA_ATTRS.has(attr.name)) continue;
      const sel = `${el.tagName.toLowerCase()}[${attr.name}="${CSS.escape(attr.value)}"]`;
      if (qsAll(sel) === 1) return sel;
      if (attr.name === "data-refid") return sel;
    }
    if (el.name) {
      const sel = `${el.tagName.toLowerCase()}[name="${CSS.escape(el.name)}"]`;
      if (qsAll(sel) === 1) return sel;
    }
    const tag = el.tagName.toLowerCase();
    const cls = Array.from(el.classList)
      .filter((c) => !/\bactive\b|\bfocus\b|\bhover\b/.test(c))
      .slice(0, 2)
      .map((c) => `.${CSS.escape(c)}`)
      .join("");
    const candidate = cls ? `${tag}${cls}` : tag;
    if (qsAll(candidate) === 1) return candidate;
    return buildNthChildSelector(el);
  }

  function buildXPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (!parent) { parts.unshift(tag); break; }
      const siblings = Array.from(parent.children).filter(
        (c) => c.tagName === node.tagName
      );
      const idx = siblings.indexOf(node) + 1;
      parts.unshift(siblings.length > 1 ? `${tag}[${idx}]` : tag);
      node = parent;
    }
    return `//${parts.join("/")}`;
  }

  function getAriaLabel(el) {
    if (!el) return null;
    const direct = el.getAttribute("aria-label");
    if (direct) return direct;
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const ref = document.getElementById(labelledBy);
      if (ref) return ref.textContent.trim();
    }
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) return label.textContent.trim();
    }
    const role = el.getAttribute("role") || el.tagName.toLowerCase();
    const text = el.textContent?.trim();
    if (["button", "link", "menuitem", "tab"].includes(role) && text && text.length < 60)
      return text;
    return null;
  }

  function generateSelectors(el) {
    if (!el || el === document || el === document.body) return [];
    const selectors = [];
    if (isSalesforce()) {
      const chain = buildShadowPierceChain(el);
      if (chain) selectors.push([chain]);
    }
    const aria = getAriaLabel(el);
    if (aria) selectors.push([`aria/${aria}`]);
    if (el.tagName === "INPUT" && (el.type === "submit" || el.type === "button") && el.value) {
      selectors.push([`input[type="${el.type}"][value="${CSS.escape(el.value)}"]`]);
    }
    const css = buildCSSSelector(el);
    if (css) selectors.push([css]);
    if (el.name) {
      const nameSel = `${el.tagName.toLowerCase()}[name="${CSS.escape(el.name)}"]`;
      if (!selectors.some((s) => s[0] === nameSel)) selectors.push([nameSel]);
    }
    const xpath = buildXPath(el);
    if (xpath) selectors.push([`xpath/${xpath}`]);
    const text = (typeof el.innerText === "string" ? el.innerText : el.textContent ?? "").trim();
    if (text && text.length > 0 && text.length < 50 && !["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) {
      selectors.push([`text/${text}`]);
    }
    return selectors;
  }

  function inferValuePattern(value) {
    if (!value) return "";
    if (/^\d+$/.test(value)) return `^\\d{${value.length}}$`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return "^\\d{4}-\\d{2}-\\d{2}$";
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$";
    if (/\d/.test(value)) {
      const escaped = value
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\d+/g, (m) => `\\d{${m.length}}`);
      return `^${escaped}$`;
    }
    return "";
  }

  function getFrameIndex() {
    if (window === window.top) return [];
    try {
      const frames = Array.from(window.parent.frames);
      const idx = frames.indexOf(window);
      return idx >= 0 ? [idx] : [];
    } catch (_) {
      return [];
    }
  }

  // ── Context menu handler ───────────────────────────────────────────────────

  document.addEventListener(
    "contextmenu",
    (e) => {
      // recorder.js handles this when a recording is active
      if (window.__recorderActive) return;

      const el = (e.composedPath?.() ?? [])[0] ?? e.target;
      if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
      if (el.tagName === "HTML" || el.tagName === "BODY") return;

      const rect = el.getBoundingClientRect();

      let elementValue = "";
      const sel = window.getSelection();
      const selText = !sel?.isCollapsed ? sel?.toString().trim() ?? "" : "";
      const selInEl =
        selText &&
        sel.anchorNode &&
        el.contains(sel.anchorNode) &&
        el.contains(sel.focusNode);

      if (selInEl) {
        elementValue = selText;
      } else if (["INPUT", "TEXTAREA"].includes(el.tagName)) {
        elementValue = el.value ?? "";
      } else if (el.tagName === "SELECT") {
        elementValue = el.value ?? "";
      } else {
        elementValue = el.textContent?.trim() ?? "";
      }

      try {
        chrome.runtime.sendMessage({
          type: "STORE_CONTEXT_EL",
          payload: {
            selectors: generateSelectors(el),
            offsetX: Math.max(0, Math.round(e.clientX - rect.left)),
            offsetY: Math.max(0, Math.round(e.clientY - rect.top)),
            frame: getFrameIndex(),
            elementValue: elementValue.slice(0, 200),
            valuePattern: inferValuePattern(elementValue),
            elementTag: el.tagName.toLowerCase(),
            elementInputType:
              el.tagName === "INPUT" ? el.type?.toLowerCase() ?? "text" : null,
            elementChecked:
              el.tagName === "INPUT" &&
              (el.type === "checkbox" || el.type === "radio")
                ? el.checked
                : null
          }
        });
      } catch (_) {
        // Extension may have been reloaded
      }
    },
    { capture: true }
  );
}
