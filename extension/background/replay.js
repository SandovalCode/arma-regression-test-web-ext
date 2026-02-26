import { MSG } from '../shared/constants.js';
import { getRecordings, appendRunResult } from '../shared/storage.js';
import { executeStep } from '../shared/step-executor.js';
import { replayState, clipboardVars, variables, frameContextMap } from './state.js';
import { cdp, broadcast, getStepDetail } from './utils.js';
import { startKeepalive, stopKeepalive } from './keepalive.js';

// ── Replay ─────────────────────────────────────────────────────────────────────
export async function runRecording(recording, tabId) {
  if (replayState.active) return; // prevent concurrent runs

  Object.assign(replayState, { active: true, aborted: false, tabId, reattachPromise: null });
  clipboardVars.clear();
  variables.clear();
  frameContextMap.clear();

  startKeepalive();

  // Start every run from a blank page so there's no leftover state from a
  // previous session. The first recorded step (navigate) will go to the real URL.
  await chrome.tabs.update(tabId, { url: 'about:blank' });
  // Give the browser a moment to load blank before attaching the debugger.
  await new Promise(r => setTimeout(r, 300));

  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const stepResults = [];

  let attached = false;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    attached = true;

    // Enable CDP domains
    await cdp(tabId, 'Runtime.enable');
    await cdp(tabId, 'Page.enable');

    for (let i = 0; i < recording.steps.length; i++) {
      // If the debugger was detached by a cross-origin navigation, wait for
      // re-attachment to complete before running the next step.
      if (replayState.reattachPromise) {
        console.log(`[Replay] step ${i + 1} waiting for debugger re-attachment...`);
        await replayState.reattachPromise;
      }
      if (replayState.aborted) break;

      const step = recording.steps[i];
      const stepStart = Date.now();
      const stepDetail = getStepDetail(step);

      broadcast(MSG.STEP_PROGRESS, {
        stepIndex: i,
        total: recording.steps.length,
        status: 'running',
        stepType: step.type,
        stepDetail,
      });

      try {
        // Auto: waitForElement before clicks, change, and selectOption steps
        if ((step.type === 'click' || step.type === 'doubleClick' || step.type === 'change' || step.type === 'selectOption') && step.selectors?.length) {
          // Ensure any in-progress re-attachment is done before issuing CDP calls.
          if (replayState.reattachPromise) await replayState.reattachPromise;
          if (!replayState.aborted) {
            console.log(`[Replay] step ${i + 1} auto → waitForElement`, JSON.stringify(step.selectors));
            await executeStep(
              { type: 'waitForElement', selectors: step.selectors, target: step.target },
              tabId, frameContextMap, clipboardVars, cdp, variables
            ).catch(err => console.warn(`[Replay] step ${i + 1} waitForElement failed (proceeding):`, err.message));
          }
          // The debugger may have detached DURING the waitForElement (e.g. Salesforce SSO).
          // waitForSelector now fails fast on CDP errors, so this re-attach wait is short.
          // After re-attachment, re-run waitForElement so the element actually settles
          // on the freshly-loaded page before the click fires.
          if (replayState.reattachPromise) {
            console.log(`[Replay] step ${i + 1} waiting for re-attachment after waitForElement detach…`);
            await replayState.reattachPromise;
            if (replayState.aborted) break;
            console.log(`[Replay] step ${i + 1} re-running waitForElement after re-attach`);
            await executeStep(
              { type: 'waitForElement', selectors: step.selectors, target: step.target },
              tabId, frameContextMap, clipboardVars, cdp, variables
            ).catch(err => console.warn(`[Replay] step ${i + 1} waitForElement (post-reattach) failed (proceeding):`, err.message));
          }
        }

        if (replayState.aborted) break;
        console.log(`[Replay] step ${i + 1}:`, JSON.stringify(step, null, 2));
        await executeStep(step, tabId, frameContextMap, clipboardVars, cdp, variables);

        // Auto: waitForPageLoad after navigate or selectOption (which may trigger navigation)
        if ((step.type === 'navigate' || step.type === 'selectOption') && !replayState.aborted) {
          // Wait for any in-progress re-attachment (e.g. Salesforce SSO fires target_closed
          // asynchronously during or just after the navigate step) before issuing CDP calls.
          if (replayState.reattachPromise) await replayState.reattachPromise;
          if (!replayState.aborted) {
            console.log(`[Replay] step ${i + 1} auto → waitForPageLoad`);
            await executeStep(
              { type: 'waitForPageLoad' },
              tabId, frameContextMap, clipboardVars, cdp, variables
            ).catch(err => console.warn(`[Replay] step ${i + 1} waitForPageLoad failed (proceeding):`, err.message));
          }
        }

        await new Promise(r => setTimeout(r, 50)); // 50 ms gap between actions

        const durationMs = Date.now() - stepStart;
        stepResults.push({ index: i, type: step.type, status: 'passed', durationMs });

        broadcast(MSG.STEP_PROGRESS, {
          stepIndex: i,
          total: recording.steps.length,
          status: 'passed',
          stepType: step.type,
          stepDetail,
          durationMs,
        });
      } catch (err) {
        const durationMs = Date.now() - stepStart;
        const errorMsg = err.message ?? String(err);
        console.error(`[Replay] step ${i + 1} (${step.type}) FAILED:`, errorMsg, step);
        stepResults.push({ index: i, type: step.type, status: 'failed', durationMs, error: errorMsg });

        broadcast(MSG.STEP_PROGRESS, {
          stepIndex: i,
          total: recording.steps.length,
          status: 'failed',
          stepType: step.type,
          stepDetail,
          durationMs,
          error: errorMsg,
        });

        // Save result and exit
        const result = {
          runId,
          recordingId: recording.id,
          recordingTitle: recording.title,
          startedAt,
          completedAt: new Date().toISOString(),
          passed: false,
          totalSteps: recording.steps.length,
          completedSteps: i,
          failedStep: { index: i, type: step.type, error: errorMsg },
          stepResults,
        };
        await appendRunResult(result);

        broadcast(MSG.RUN_COMPLETE, {
          recordingId: recording.id,
          runId,
          passed: false,
          failedStep: result.failedStep,
        });

        return result;
      }
    }

    // All steps done (or aborted)
    const passed = !replayState.aborted;
    const result = {
      runId,
      recordingId: recording.id,
      recordingTitle: recording.title,
      startedAt,
      completedAt: new Date().toISOString(),
      passed,
      totalSteps: recording.steps.length,
      completedSteps: stepResults.filter(s => s.status === 'passed').length,
      failedStep: null,
      stepResults,
    };
    await appendRunResult(result);
    broadcast(MSG.RUN_COMPLETE, { recordingId: recording.id, runId, passed, failedStep: null });
    return result;

  } finally {
    if (attached) {
      try { await chrome.debugger.detach({ tabId }); } catch (_) {}
    }
    // Preserve `aborted` so runAll's outer loop can detect a mid-batch abort.
    // The next call to runRecording resets it to false at its own start.
    replayState.active = false;
    replayState.tabId = null;
    stopKeepalive();
  }
}

export async function runAll(tabId) {
  const recordings = await getRecordings();
  if (recordings.length === 0) return;

  const results = [];

  for (let i = 0; i < recordings.length; i++) {
    if (replayState.aborted) break;

    broadcast(MSG.BATCH_PROGRESS, {
      current: i + 1,
      total: recordings.length,
      recordingTitle: recordings[i].title,
    });

    const result = await runRecording(recordings[i], tabId);
    results.push({ recordingId: recordings[i].id, title: recordings[i].title, passed: result?.passed ?? false });
  }

  broadcast(MSG.BATCH_COMPLETE, { results });
}
