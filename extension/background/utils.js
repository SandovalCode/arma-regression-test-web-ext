// ── CDP helper ─────────────────────────────────────────────────────────────────
export function cdp(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

// ── Broadcast to all extension views ──────────────────────────────────────────
export function broadcast(type, payload = {}) {
  chrome.runtime.sendMessage({ type, payload }).catch(() => {});
}

// ── Step detail for progress display ──────────────────────────────────────────
export function getStepDetail(step) {
  const sel = step.selectors?.flat?.().find(Boolean) ?? '';
  switch (step.type) {
    case 'navigate':    return step.url ?? '';
    case 'click':
    case 'doubleClick':
    case 'hover':       return sel;
    case 'selectOption': return `${sel} → "${step.label ?? step.value}"`;
    case 'change':      return `${sel}${step.value ? ` → "${step.value}"` : ''}`;
    case 'waitForElement': return sel;
    default:            return sel;
  }
}
