import { MAX_HISTORY_ENTRIES } from './constants.js';

// ─── Recordings ──────────────────────────────────────────────────────────────

export async function getRecordings() {
  const { recordings = [] } = await chrome.storage.local.get('recordings');
  return recordings;
}

export async function saveRecording({ id, title, steps, createdAt }) {
  const recordings = await getRecordings();
  const existing = recordings.findIndex(r => r.id === id);
  // Preserve original createdAt when updating; only set to now for new recordings
  const existingCreatedAt = existing >= 0 ? recordings[existing].createdAt : null;
  const entry = { id, title, createdAt: createdAt ?? existingCreatedAt ?? new Date().toISOString(), steps };
  if (existing >= 0) {
    recordings[existing] = entry;
  } else {
    recordings.push(entry);
  }
  await chrome.storage.local.set({ recordings });
  return entry;
}

export async function deleteRecording(id) {
  const recordings = await getRecordings();
  await chrome.storage.local.set({ recordings: recordings.filter(r => r.id !== id) });
}

// ─── Run History ──────────────────────────────────────────────────────────────

export async function getRunHistory(recordingId = null) {
  const { runHistory = [] } = await chrome.storage.local.get('runHistory');
  if (recordingId) return runHistory.filter(r => r.recordingId === recordingId);
  return runHistory;
}

export async function appendRunResult(result) {
  const { runHistory = [] } = await chrome.storage.local.get('runHistory');
  runHistory.unshift(result); // newest first
  if (runHistory.length > MAX_HISTORY_ENTRIES) runHistory.length = MAX_HISTORY_ENTRIES;
  await chrome.storage.local.set({ runHistory });
}

// ─── Active Run (ephemeral) ───────────────────────────────────────────────────

export async function setActiveRun(run) {
  await chrome.storage.local.set({ activeRun: run });
}

export async function clearActiveRun() {
  await chrome.storage.local.remove('activeRun');
}

export async function getActiveRun() {
  const { activeRun = null } = await chrome.storage.local.get('activeRun');
  return activeRun;
}
