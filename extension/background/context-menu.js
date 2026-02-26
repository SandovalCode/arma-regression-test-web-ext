import { MSG } from '../shared/constants.js';
import { recordingState, contextMenu } from './state.js';
import { broadcast } from './utils.js';

// ── Context menu: "Record Hover" + "Wait for element" ─────────────────────────
// Create once on SW startup (removeAll first to avoid duplicates on reload)
chrome.contextMenus.removeAll(() => {
  chrome.contextMenus.create({
    id: 'record-hover',
    title: 'Record Hover',
    contexts: ['all'],
  });
  chrome.contextMenus.create({
    id: 'record-wait',
    title: 'Wait for element',
    contexts: ['all'],
  });
  chrome.contextMenus.create({
    id: 'record-variable',
    title: 'Save variable',
    contexts: ['all'],
  });
  chrome.contextMenus.create({
    id: 'record-paste-variable',
    title: 'Paste variable',
    contexts: ['all'],
  });
  chrome.contextMenus.create({
    id: 'record-wait-time',
    title: 'Wait for time',
    contexts: ['all'],
  });
});

chrome.contextMenus.onClicked.addListener(async (_info, tab) => {
  if (!recordingState.active || tab?.id !== recordingState.tabId) return;
  if (!['record-hover', 'record-wait', 'record-variable', 'record-paste-variable', 'record-wait-time'].includes(_info.menuItemId)) return;

  // Wait-for-time doesn't need element info — handle it before the elInfo check.
  if (_info.menuItemId === 'record-wait-time') {
    broadcast(MSG.SHOW_WAIT_DIALOG, {});
    return;
  }

  // Use the element info stored by the content script via STORE_CONTEXT_EL.
  // If the SW was killed between the right-click and this click, in-memory state
  // is gone — fall back to session storage which survives SW restarts.
  let elInfo = contextMenu.lastEl;
  if (!elInfo) {
    const stored = await chrome.storage.session.get('lastContextMenuEl').catch(() => ({}));
    elInfo = stored.lastContextMenuEl ?? null;
  }
  if (!elInfo) return;
  contextMenu.lastEl = null; // consume in-memory copy
  chrome.storage.session.remove('lastContextMenuEl').catch(() => {}); // consume persisted copy

  if (_info.menuItemId === 'record-variable') {
    // Prompt the user for a variable name via the sidepanel dialog.
    // The step will be added to recordingState when the sidepanel responds
    // with ADD_RECORDING_STEP after the user confirms the dialog.
    broadcast(MSG.SHOW_VARIABLE_DIALOG, {
      selectors: elInfo.selectors,
      defaultValue: elInfo.elementValue ?? '',
      frame: elInfo.frame ?? [],
    });
    return;
  }

  if (_info.menuItemId === 'record-paste-variable') {
    // Collect saved variables with their defaultValues so the sidepanel can
    // both display them and embed a fallback value in the recorded step.
    const availableVars = recordingState.steps
      .filter(s => s.type === 'saveVariable')
      .map(s => ({ name: s.variableName, defaultValue: s.defaultValue ?? '' }));
    broadcast(MSG.SHOW_PASTE_VARIABLE_DIALOG, {
      selectors: elInfo.selectors,
      frame: elInfo.frame ?? [],
      variables: availableVars,
    });
    return;
  }

  let step;
  if (_info.menuItemId === 'record-hover') {
    step = {
      type: 'hover',
      target: 'main',
      selectors: elInfo.selectors,
      offsetX: elInfo.offsetX,
      offsetY: elInfo.offsetY,
      ...(elInfo.frame?.length ? { frame: elInfo.frame } : {}),
    };
  } else {
    step = {
      type: 'waitForElement',
      target: 'main',
      selectors: elInfo.selectors,
      ...(elInfo.frame?.length ? { frame: elInfo.frame } : {}),
    };
  }

  recordingState.steps.push(step);
  broadcast(MSG.RECORD_STEP, { step });
});
