// ── In-memory state ────────────────────────────────────────────────────────────
export const recordingState = {
  active: false,
  tabId: null,
  steps: []
};

export const replayState = {
  active: false,
  aborted: false,
  tabId: null,
  debugResolve: null, // set while paused at a debug step; call to resume
  debugFinished: false, // true after user clicks "Finish debugging"
  stepOnce: false, // pause after the very next step (set by DEBUG_NEXT)
  dynamicBreakpoints: new Set() // step indices set via the hover pause button
};

// Clipboard variables that survive cross-site navigation during a run
export const clipboardVars = new Map();

// User-defined variables saved during a run via the "Save variable" step
export const variables = new Map();

// Variable snapshots captured during recording (variableName → snapshotValue).
// Used to replace literal values in recorded steps with {{varName}} references.
export const recordingVarSnapshots = new Map();

// Execution context map: frameId → executionContextId (populated via Runtime events)
export const frameContextMap = new Map();

// Network request tracking: counts in-flight requests during replay.
// Used to wait for AJAX-driven content (e.g. wizard steps) to finish loading after a click.
export const networkState = { pendingCount: 0 };

// Last right-clicked element sent from the content script via STORE_CONTEXT_EL.
// Wrapped in an object so both message-router.js and context-menu.js can mutate
// it through the same shared reference (ES modules cannot re-assign imported bindings).
export const contextMenu = { lastEl: null };
