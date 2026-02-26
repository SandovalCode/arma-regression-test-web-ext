// ── In-memory state ────────────────────────────────────────────────────────────
export const recordingState = {
  active: false,
  tabId: null,
  steps: [],
};

export const replayState = {
  active: false,
  aborted: false,
  tabId: null,
};

// Clipboard variables that survive cross-site navigation during a run
export const clipboardVars = new Map();

// User-defined variables saved during a run via the "Save variable" step
export const variables = new Map();

// Execution context map: frameId → executionContextId (populated via Runtime events)
export const frameContextMap = new Map();

// Last right-clicked element sent from the content script via STORE_CONTEXT_EL.
// Wrapped in an object so both message-router.js and context-menu.js can mutate
// it through the same shared reference (ES modules cannot re-assign imported bindings).
export const contextMenu = { lastEl: null };
