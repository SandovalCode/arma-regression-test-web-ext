import { MSG } from "../shared/constants.js";
import { saveRecording } from "../shared/storage.js";
import { recordingState, replayState, recordingVarSnapshots } from "./state.js";
import { broadcast, disableConflictingExtensions, restoreConflictingExtensions } from "./utils.js";
import { startKeepalive, stopKeepalive } from "./keepalive.js";

// ── Recording ──────────────────────────────────────────────────────────────────
export async function startRecording(tabId) {
  await disableConflictingExtensions();

  // Always force-cleanup any previous recorder session first.
  // This resets window.__recorderActive so the re-injection guard doesn't block us.
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        window.__recorderCleanup?.();
        window.__recorderActive = false;
      }
    });
  } catch (_) {
    /* tab may not be ready yet, proceed anyway */
  }

  // Record the current page as the first step so replay always begins on the right page.
  const tab = await chrome.tabs.get(tabId);
  const startUrl = tab.url ?? "";
  const firstStep = {
    type: "navigate",
    url: startUrl,
    assertedEvents: [{ type: "navigation", url: startUrl, title: "" }]
  };

  recordingVarSnapshots.clear();
  Object.assign(recordingState, { active: true, tabId, steps: [firstStep] });
  startKeepalive();
  broadcast(MSG.RECORD_STEP, { step: firstStep });

  // Inject recorder content script
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ["content/recorder.js"]
  });

  // Also inject on future navigations within this tab
  chrome.webNavigation.onDOMContentLoaded.addListener(onNavCommitted);
}

async function onNavCommitted(details) {
  if (!recordingState.active || details.tabId !== recordingState.tabId) return;
  if (details.frameId !== 0) return; // only main-frame navigations

  // Skip internal browser URLs
  const url = details.url ?? "";
  if (!url || url.startsWith("chrome://") || url.startsWith("about:")) return;
  if (url.startsWith("chrome-extension://")) {
    console.warn(
      "[Recorder] Tab navigated to another extension's page — recording is paused." +
      " Steps will resume when the tab returns to a web page." +
      " (Is 'Salesforce Inspector Reloaded' or another extension intercepting this tab?)"
    );
    return;
  }

  // Record a navigate step with the CORRECT destination URL
  // (details.url is where we're arriving, not where we came from)
  const step = {
    type: "navigate",
    url,
    assertedEvents: [{ type: "navigation", url, title: "" }]
  };
  recordingState.steps.push(step);
  broadcast(MSG.RECORD_STEP, { step });

  // Re-inject recorder into the new page
  try {
    await chrome.scripting.executeScript({
      target: { tabId: details.tabId, allFrames: true },
      files: ["content/recorder.js"]
    });
  } catch (err) {
    console.warn("[Recorder] Re-inject after nav failed:", err.message);
  }
}

export async function continueRecording(tabId, steps) {
  await disableConflictingExtensions();

  // Same cleanup as startRecording — reset any previous recorder session
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        window.__recorderCleanup?.();
        window.__recorderActive = false;
      }
    });
  } catch (err) {
    console.error(err);
  }

  recordingVarSnapshots.clear();
  Object.assign(recordingState, { active: true, tabId, steps: [...steps] });
  startKeepalive();

  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ["content/recorder.js"]
  });

  chrome.webNavigation.onDOMContentLoaded.addListener(onNavCommitted);
}

export async function stopRecording(name, sendResponse) {
  if (!recordingState.active) {
    sendResponse({ ok: false });
    return;
  }

  recordingState.active = false;
  stopKeepalive();
  chrome.webNavigation.onDOMContentLoaded.removeListener(onNavCommitted);

  // Remove the recorder script from the tab by calling cleanup
  try {
    await chrome.scripting.executeScript({
      target: { tabId: recordingState.tabId, allFrames: true },
      func: () => {
        window.__recorderCleanup?.();
      }
    });
  } catch (e) {
    console.error(e);
  }

  const id = crypto.randomUUID();
  const saved = await saveRecording({
    id,
    title: name,
    steps: recordingState.steps
  });
  broadcast(MSG.RECORDING_STATE, { recording: false });
  sendResponse({ ok: true, recording: saved });
  await restoreConflictingExtensions();
}

export async function abortRecording() {
  recordingState.active = false;
  stopKeepalive();
  chrome.webNavigation.onDOMContentLoaded.removeListener(onNavCommitted);
  await restoreConflictingExtensions();
  if (!recordingState.tabId) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: recordingState.tabId, allFrames: true },
      func: () => {
        window.__recorderCleanup?.();
      }
    });
  } catch (e) {
    console.error(e);
  }
}

export async function forceReset() {
  // 1. Tear down any active recording
  if (recordingState.active) {
    recordingState.active = false;
    chrome.webNavigation.onDOMContentLoaded.removeListener(onNavCommitted);
    try {
      await chrome.scripting.executeScript({
        target: { tabId: recordingState.tabId, allFrames: true },
        func: () => {
          window.__recorderCleanup?.();
        }
      });
    } catch (e) {
      console.error(e);
    }
  }
  recordingVarSnapshots.clear();
  Object.assign(recordingState, { active: false, tabId: null, steps: [] });

  // 2. Tear down any active replay
  if (replayState.active && replayState.tabId) {
    try {
      await chrome.debugger.detach({ tabId: replayState.tabId });
    } catch (e) {
      console.error(e);
    }
  }
  Object.assign(replayState, {
    active: false,
    aborted: false,
    tabId: null,
    reattachPromise: null
  });

  // 3. Stop keepalive alarm
  stopKeepalive();

  // 4. Notify sidepanel so it resets its UI to idle
  broadcast(MSG.RECORDING_STATE, { recording: false });
}
