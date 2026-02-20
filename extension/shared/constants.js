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

  // Storage
  DELETE_RECORDING: 'DELETE_RECORDING',
  GET_RECORDINGS:   'GET_RECORDINGS',
  GET_HISTORY:      'GET_HISTORY',

  // service-worker → sidepanel (events)
  STORE_CONTEXT_EL: 'STORE_CONTEXT_EL',  // content script → SW: store right-clicked element
  RECORD_STEP:      'RECORD_STEP',       // a step was captured during recording
  STEP_PROGRESS:    'STEP_PROGRESS',     // a step finished during replay
  RUN_COMPLETE:     'RUN_COMPLETE',      // a single recording run finished
  BATCH_PROGRESS:   'BATCH_PROGRESS',    // batch: moved to next recording
  BATCH_COMPLETE:   'BATCH_COMPLETE',    // batch: all recordings done
  RECORDING_STATE:  'RECORDING_STATE',   // recording started/stopped confirmation
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
