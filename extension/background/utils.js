// ── Conflicting extension management ───────────────────────────────────────────
// Extensions known to conflict with recording/replay (e.g. they also use chrome.debugger
// or intercept tab navigation). Matched by a substring of the extension name.
const CONFLICTING_EXT_NAMES = ["Salesforce Inspector"];

// IDs of extensions we disabled at session start — restored when the session ends.
const _disabledByUs = new Set();

export async function disableConflictingExtensions() {
  try {
    const all = await chrome.management.getAll();
    for (const ext of all) {
      if (!ext.enabled) continue;
      if (!CONFLICTING_EXT_NAMES.some((name) => ext.name.includes(name))) continue;
      await chrome.management.setEnabled(ext.id, false);
      _disabledByUs.add(ext.id);
      console.log(`[Session] Disabled conflicting extension: "${ext.name}"`);
    }
  } catch (err) {
    console.warn("[Session] Could not disable conflicting extensions:", err.message);
  }
}

export async function restoreConflictingExtensions() {
  for (const id of _disabledByUs) {
    try {
      await chrome.management.setEnabled(id, true);
      console.log(`[Session] Re-enabled extension: ${id}`);
    } catch (err) {
      console.warn(`[Session] Could not re-enable extension ${id}:`, err.message);
    }
  }
  _disabledByUs.clear();
}

// ── CDP helper ─────────────────────────────────────────────────────────────────
export function cdp(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

// ── Broadcast to all extension views ──────────────────────────────────────────
export function broadcast(type, payload = {}) {
  chrome.runtime.sendMessage({ type, payload }).catch(console.error);
}

// ── Step detail for progress display ──────────────────────────────────────────
export function getStepDetail(step) {
  const sel = step.selectors?.flat?.().find(Boolean) ?? "";
  switch (step.type) {
    case "navigate":
      return step.url ?? "";
    case "click":
    case "doubleClick":
    case "hover":
      return sel;
    case "selectOption":
      return `${sel} → "${step.label ?? step.value}"`;
    case "change":
      return `${sel}${step.value ? ` → "${step.value}"` : ""}`;
    case "waitForElement":
      return sel;
    default:
      return sel;
  }
}
