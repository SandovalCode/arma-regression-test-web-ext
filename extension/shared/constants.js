// Message types: sidepanel → service-worker
export const MSG = {
  // Recording control
  START_RECORDING:  'START_RECORDING',
  STOP_RECORDING:   'STOP_RECORDING',
  ABORT_RECORDING:  'ABORT_RECORDING',

  // Replay control
  RUN_RECORDING:    'RUN_RECORDING',
  RUN_ALL:          'RUN_ALL',
  ABORT_RUN:        'ABORT_RUN',
  RESET_STATE:      'RESET_STATE',      // sidepanel → SW: force-clear all recording/replay state

  // Storage
  DELETE_RECORDING: 'DELETE_RECORDING',
  GET_RECORDINGS:   'GET_RECORDINGS',
  GET_HISTORY:      'GET_HISTORY',
  DELETE_STEP:        'DELETE_STEP',        // sidepanel → SW: remove a step by index during recording
  UPDATE_RECORDING:   'UPDATE_RECORDING',   // sidepanel → SW: save edited title/steps of a saved recording
  ADD_RECORDING_STEP:    'ADD_RECORDING_STEP',    // sidepanel → SW: push a manually-created step
  UPDATE_RECORDING_STEP: 'UPDATE_RECORDING_STEP', // sidepanel → SW: update value of a step by index

  // service-worker → sidepanel (events)
  STORE_CONTEXT_EL:     'STORE_CONTEXT_EL',     // content script → SW: store right-clicked element
  RECORD_STEP:          'RECORD_STEP',           // a step was captured during recording
  STEP_PROGRESS:        'STEP_PROGRESS',         // a step finished during replay
  RUN_COMPLETE:         'RUN_COMPLETE',           // a single recording run finished
  BATCH_PROGRESS:       'BATCH_PROGRESS',        // batch: moved to next recording
  BATCH_COMPLETE:       'BATCH_COMPLETE',        // batch: all recordings done
  RECORDING_STATE:      'RECORDING_STATE',       // recording started/stopped confirmation
  SHOW_VARIABLE_DIALOG:       'SHOW_VARIABLE_DIALOG',       // SW → sidepanel: open the save-variable dialog
  SHOW_PASTE_VARIABLE_DIALOG: 'SHOW_PASTE_VARIABLE_DIALOG', // SW → sidepanel: open the paste-variable dialog
  SHOW_WAIT_DIALOG:           'SHOW_WAIT_DIALOG',           // SW → sidepanel: open the wait-for-time dialog
};

export const StepStatus = {
  PENDING:  'pending',
  RUNNING:  'running',
  PASSED:   'passed',
  FAILED:   'failed',
};

export const RecordingState = {
  IDLE:       'idle',
  RECORDING:  'recording',
  REPLAYING:  'replaying',
};

// Timeouts
export const STEP_TIMEOUT_MS   = 30_000;  // max time per step (waitForElement)
export const NAV_TIMEOUT_MS    = 20_000;  // max time for navigation to complete
export const POLL_INTERVAL_MS  = 500;     // waitForElement polling interval
export const KEEPALIVE_MINS    = 0.4;     // alarm period to keep SW alive (~24s)

export const MAX_HISTORY_ENTRIES = 100;

// Hostnames (suffix match) that continuously poll the network and never reach
// readyState='complete'. For these, waitForPageLoad skips polling and uses a
// fixed sleep instead. Add new entries here as needed.
export const POLLING_DOMAINS = [
  'force.com',  // Salesforce Lightning: *.lightning.force.com, *.sandbox.lightning.force.com, etc.
];
