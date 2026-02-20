# Test Recorder — Chrome Extension

> **Language rule:** All code, comments, variable names, and any content in this codebase must be written in **English**. This includes future code changes, new files, commit messages, and responses from Claude.

## What is this project?

A Chrome Extension (Manifest V3) that lets **non-technical users** record browser interactions and replay them automatically. It replaces Puppeteer/Playwright, which get blocked by paid-subscription sites. The extension runs in the real browser without automation flags, so it is undetectable as a bot.

## Why does it exist?

The team has no QA. Users need to:
1. Record their browser actions with one click from the side panel
2. Replay those actions automatically
3. View all saved tests, run them one by one or all in sequence

## File structure

```
extension/
  manifest.json                  ← MV3 manifest, permissions, entry points
  background/
    service-worker.js            ← Main orchestrator: recording, replay, CDP, context menus
  content/
    recorder.js                  ← Dynamically injected during recording; captures DOM events
  sidepanel/
    sidepanel.html               ← Main UI (sole visual entry point)
    sidepanel.js                 ← UI logic, messaging with SW
    sidepanel.css                ← Dark theme (default) + light theme toggle
  shared/
    constants.js                 ← Message types (MSG), status codes, timeouts
    storage.js                   ← chrome.storage.local wrappers
    selector-resolver.js         ← Resolves selectors with fallback (aria → css → xpath → pierce → text)
    step-executor.js             ← Maps each step type to CDP commands
  assets/
    icon16/48/128.png
```

## Recording flow

1. User clicks "Iniciar grabación" → sidepanel sends `START_RECORDING` to SW with `tabId`
2. SW immediately records the current tab URL as the first step (`navigate`)
3. SW injects `content/recorder.js` into the active tab (all frames)
4. `recorder.js` listens for: `click`, `mouseup`, `input`, `change`, `copy`, `paste`, `keydown`, `keyup`, `contextmenu`
5. Each event → `chrome.runtime.sendMessage({ type: 'RECORD_STEP', payload: { step } })`
6. The sidepanel receives the message directly from the content script and renders it in the live feed
7. The SW also receives it and pushes the step into `recordingState.steps`
8. On page navigation: `webNavigation.onDOMContentLoaded` → SW records a `navigate` step with the correct destination URL + re-injects `recorder.js`
9. User clicks "Detener" → name dialog → SW saves to `chrome.storage.local`

**Important:** `navigate` steps are recorded by the SW (from `onDOMContentLoaded`), NOT by the content script. `beforeunload` is not used because it only knew the source URL, not the destination.

## Replay flow

1. Sidepanel sends `RUN_RECORDING` (or `RUN_ALL`) to SW
2. SW: `chrome.debugger.attach({ tabId }, '1.3')` → enables CDP
3. For each step: `executeStep(step, tabId, ...)` → waits 400ms between steps
4. SW broadcasts `STEP_PROGRESS` → sidepanel updates the progress bar in real time
5. On finish: `appendRunResult(result)` → `chrome.debugger.detach`

## Step types and CDP mapping

| Step type | CDP action |
|---|---|
| `navigate` | `chrome.tabs.get` → if loading: wait for `Page.loadEventFired`; if already at URL: skip; otherwise: `Page.navigate` |
| `click` | `Input.dispatchMouseEvent` (moved → pressed → released) |
| `doubleClick` | Same as click with `clickCount: 2` |
| `hover` | `Input.dispatchMouseEvent type:mouseMoved` |
| `change` | focus + `Input.insertText` + dispatch input/change events |
| `keyDown/keyUp` | `Input.dispatchKeyEvent` |
| `waitForElement` | Polling `Runtime.evaluate` every 500ms, 30s timeout |
| `copy` | `Runtime.evaluate` to capture selected text → stored in SW's `clipboardVars` Map |
| `paste` | Read `clipboardVars[variableName]` → `Input.insertText` (works cross-site) |
| `scroll` | `Input.dispatchMouseEvent type:mouseWheel` |
| `setViewport` | `Emulation.setDeviceMetricsOverride` |

## Selectors (5 strategies with fallback)

Priority order in `selector-resolver.js`:
1. `aria/<label>` — aria-label, aria-labelledby, label[for]
2. Minimal CSS selector (`#id`, `[data-*]`, `[name=]`, tag+class)
3. `xpath/<expr>` — relative path from root
4. `pierce/<css>` — CSS selector that pierces shadow DOM (recursive)
5. `text/<content>` — visible text content match

## Context menu (right-click during recording)

Two options, only available when a recording is active:
- **Registrar Hover** → records a `hover` step on the element under the cursor
- **Esperar elemento** → records a `waitForElement` step on the element under the cursor

The content script sends element info via `STORE_CONTEXT_EL` to the SW. The SW stores it in `lastContextMenuEl` and consumes it when the user selects a menu option.

## Messages (constants.js)

```js
// sidepanel → SW
START_RECORDING, STOP_RECORDING, ABORT_RECORDING
RUN_RECORDING, RUN_ALL, ABORT_RUN
GET_RECORDINGS, GET_HISTORY
DELETE_RECORDING
DELETE_STEP    // removes a step by index during recording (splice from recordingState.steps)

// content script → SW
STORE_CONTEXT_EL   // element info from right-click (for context menu handler)
RECORD_STEP        // captured step (also delivered directly to sidepanel)

// SW → sidepanel (broadcasts)
RECORD_STEP        // step created by SW itself (hover, navigate)
STEP_PROGRESS      // replay progress update
RUN_COMPLETE       // single run finished (passed/failed)
BATCH_PROGRESS     // batch: moved to next recording
BATCH_COMPLETE     // batch: all recordings done
RECORDING_STATE    // confirmation of stop/abort
```

## SW in-memory state

```js
recordingState    = { active: bool, tabId: number, steps: Step[] }
replayState       = { active: bool, aborted: bool, tabId: number }
clipboardVars     = Map<variableName, copiedText>   // persists across the entire run (cross-site safe)
frameContextMap   = Map<frameId, executionContextId>
lastContextMenuEl = { selectors, offsetX, offsetY, frame }  // last right-clicked element
```

## Data model (chrome.storage.local)

**recordings** — `Recording[]`
```js
{ id: string, title: string, createdAt: ISO, steps: Step[] }
```

**runHistory** — `RunResult[]` (max 100 entries)
```js
{
  runId, recordingId, recordingTitle,
  startedAt, completedAt,
  passed: bool,
  totalSteps, completedSteps,
  failedStep: { index, type, error } | null,
  stepResults: [{ index, type, status, durationMs, error? }]
}
```

## Key technical details

- **SW keep-alive**: `chrome.alarms` fires every ~24s during long runs (`KEEPALIVE_MINS = 0.4`)
- **Double-injection guard**: `window.__recorderActive` flag in content script; `startRecording` always cleans up before re-injecting
- **Step deduplication**: 200ms window in `sendStep()` in `recorder.js` (prevents double-registration from label→input synthetic clicks)
- **RECORD_STEP is not re-broadcast**: the sidepanel already receives it directly from the content script. It is only broadcast for steps created inside the SW (hover, navigate)
- **400ms gap between steps**: the replay loop does `await new Promise(r => setTimeout(r, 400))` after each successful step
- **Delete step during recording**: sidepanel sends `DELETE_STEP { index }` → SW does `splice(index, 1)` on `recordingState.steps`; sidepanel removes the `<li>` from the feed and decrements the step counter

## Loading the extension

1. Go to `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" → select the `extension/` folder
4. The icon appears in the toolbar; clicking it opens the side panel
