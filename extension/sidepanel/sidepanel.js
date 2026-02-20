import { MSG, StepStatus, RecordingState } from '../shared/constants.js';

// ── State ──────────────────────────────────────────────────────────────────────
let state = {
  mode: RecordingState.IDLE,   // 'idle' | 'recording' | 'replaying'
  recordingStepCount: 0,
  currentRunSteps: [],
  recordings: [],
};

// ── DOM refs ───────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const recordIdle       = $('record-idle');
const recordActive     = $('record-active');
const btnStartRecord   = $('btn-start-record');
const btnStopRecord    = $('btn-stop-record');
const btnCancelRecord  = $('btn-cancel-record');
const stepCountEl      = $('step-count');
const recordFeed       = $('record-feed');
const recordingsEmpty  = $('recordings-empty');
const recordingsList   = $('recordings-list');
const btnRunAll        = $('btn-run-all');
const runSection       = $('run-section');
const runTitle         = $('run-title');
const runSubtitle      = $('run-subtitle');
const progressBar      = $('progress-bar');
const stepsList        = $('steps-list');
const btnAbort         = $('btn-abort');
const batchSection     = $('batch-section');
const batchSummary     = $('batch-summary');
const batchResults     = $('batch-results');
const nameOverlay      = $('name-overlay');
const dialogNameInput  = $('dialog-name');
const btnDialogSave    = $('btn-dialog-save');
const btnDialogCancel  = $('btn-dialog-cancel');
const btnTheme         = $('btn-theme');

// ── Theme toggle ───────────────────────────────────────────────────────────────
function applyTheme(light) {
  document.documentElement.classList.toggle('light', light);
  btnTheme.textContent = light ? '🌙' : '☀️';
}

const savedTheme = localStorage.getItem('theme');
applyTheme(savedTheme === 'light');

btnTheme.addEventListener('click', () => {
  const isLight = document.documentElement.classList.toggle('light');
  btnTheme.textContent = isLight ? '🌙' : '☀️';
  localStorage.setItem('theme', isLight ? 'light' : 'dark');
});

// ── Helpers ────────────────────────────────────────────────────────────────────
function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, payload });
}

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

function timeAgo(isoStr) {
  if (!isoStr) return '';
  const diff = Date.now() - new Date(isoStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'hace un momento';
  if (m < 60) return `hace ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `hace ${h}h`;
  return `hace ${Math.floor(h / 24)}d`;
}

function formatDate(isoStr) {
  if (!isoStr) return '';
  return new Date(isoStr).toLocaleDateString('es', { day: '2-digit', month: 'short' });
}

// ── Render recordings list ─────────────────────────────────────────────────────
function renderRecordings(recordings) {
  state.recordings = recordings;
  recordingsList.innerHTML = '';

  if (recordings.length === 0) {
    recordingsEmpty.classList.remove('hidden');
    btnRunAll.disabled = true;
    return;
  }

  recordingsEmpty.classList.add('hidden');
  btnRunAll.disabled = state.mode !== RecordingState.IDLE;

  for (const rec of recordings) {
    const li = document.createElement('li');
    li.className = 'recording-card';
    li.dataset.id = rec.id;

    const lastRun = rec.lastRun;
    const badgeHtml = lastRun
      ? `<span class="badge ${lastRun.passed ? 'badge-pass' : 'badge-fail'}">
           ${lastRun.passed ? '✅ PASS' : '❌ FALLO'}
         </span>
         <span>${lastRun.completedSteps}/${lastRun.totalSteps} pasos · ${timeAgo(lastRun.completedAt)}</span>`
      : `<span class="badge badge-none">Sin ejecutar</span>`;

    li.innerHTML = `
      <div class="recording-card-header">
        <div>
          <div class="recording-title">${escapeHtml(rec.title)}</div>
          <div class="recording-meta">${rec.steps?.length ?? 0} pasos · ${formatDate(rec.createdAt)}</div>
        </div>
      </div>
      <div class="last-run">${badgeHtml}</div>
      <div class="recording-card-actions">
        <button class="btn btn-primary btn-sm btn-run" data-id="${rec.id}">▶ Correr</button>
        <button class="btn btn-ghost btn-sm btn-delete" data-id="${rec.id}">🗑</button>
      </div>
    `;
    recordingsList.appendChild(li);
  }
}

function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Render step progress ───────────────────────────────────────────────────────
function addOrUpdateStep({ stepIndex, total, status, stepType, durationMs, error }) {
  // update progress bar
  const pct = total > 0 ? Math.round(((stepIndex + 1) / total) * 100) : 0;
  progressBar.style.width = `${pct}%`;
  runSubtitle.textContent = `Paso ${stepIndex + 1} de ${total}`;

  // update or create step item
  let li = stepsList.querySelector(`[data-step="${stepIndex}"]`);
  if (!li) {
    li = document.createElement('li');
    li.className = 'step-item';
    li.dataset.step = stepIndex;
    stepsList.appendChild(li);
  }

  const icons = { pending: '⏳', running: '🔄', passed: '✅', failed: '❌' };
  const dur = durationMs ? `${durationMs}ms` : '';

  li.className = `step-item ${status}`;
  li.innerHTML = `
    <span class="step-icon">${icons[status] ?? '·'}</span>
    <span class="step-label">${stepType ?? ''}</span>
    <span class="step-duration">${dur}</span>
    ${error ? `<div class="step-error">${escapeHtml(error)}</div>` : ''}
  `;

  // scroll to running step
  if (status === StepStatus.RUNNING) li.scrollIntoView({ block: 'nearest' });
}

// ── UI state transitions ───────────────────────────────────────────────────────
function setMode(mode) {
  state.mode = mode;

  const isIdle      = mode === RecordingState.IDLE;
  const isRecording = mode === RecordingState.RECORDING;
  const isReplaying = mode === RecordingState.REPLAYING;

  // record area
  recordIdle.classList.toggle('hidden', !isIdle);
  recordActive.classList.toggle('hidden', !isRecording);

  // run section
  if (!isReplaying) {
    runSection.classList.add('hidden');
  }

  // disable run buttons while busy
  btnRunAll.disabled = !isIdle || state.recordings.length === 0;
  document.querySelectorAll('.btn-run').forEach(b => b.disabled = !isIdle);
}

function showRunSection(title) {
  runTitle.textContent = `Corriendo: "${title}"`;
  runSubtitle.textContent = '';
  progressBar.style.width = '0%';
  stepsList.innerHTML = '';
  runSection.classList.remove('hidden');
  batchSection.classList.add('hidden');
  setMode(RecordingState.REPLAYING);
}

// ── Event listeners ────────────────────────────────────────────────────────────

// ── Step label helpers ─────────────────────────────────────────────────────────
const STEP_ICONS = {
  click:          '🖱️',
  doubleClick:    '🖱️',
  hover:          '👆',
  change:         '⌨️',
  navigate:       '🔗',
  keyDown:        '⌨️',
  keyUp:          '⌨️',
  copy:           '📋',
  paste:          '📄',
  scroll:         '📜',
  waitForElement: '⏳',
  setViewport:    '🖥️',
};

function stepLabel(step) {
  // Extract the most human-readable selector string available
  const sel = step.selectors?.flat?.().find(Boolean) ?? '';
  const ariaMatch = sel.match(/^aria\/(.+)/);
  const textMatch = sel.match(/^text\/(.+)/);
  const selectorHint = ariaMatch?.[1] ?? textMatch?.[1] ?? (sel.replace(/^(xpath|pierce|css)\//, '').slice(0, 30) || '');

  switch (step.type) {
    case 'click':
    case 'doubleClick':
      return { main: step.type === 'doubleClick' ? 'Doble click' : 'Click', sub: selectorHint };
    case 'hover':
      return { main: 'Hover', sub: selectorHint };
    case 'change':
      return { main: 'Escribir', sub: `"${String(step.value ?? '').slice(0, 30)}"` };
    case 'navigate':
      return { main: 'Navegar', sub: (step.url ?? '').replace(/^https?:\/\//, '').slice(0, 40) };
    case 'keyDown':
      return { main: `Tecla ↓ ${step.key}`, sub: '' };
    case 'keyUp':
      return { main: `Tecla ↑ ${step.key}`, sub: '' };
    case 'copy':
      return { main: 'Copiar', sub: `"${String(step.snapshotValue ?? '').slice(0, 30)}"` };
    case 'paste':
      return { main: 'Pegar', sub: selectorHint };
    case 'scroll':
      return { main: 'Scroll', sub: '' };
    case 'waitForElement':
      return { main: 'Esperar elemento', sub: selectorHint };
    case 'setViewport':
      return { main: `Viewport ${step.width}×${step.height}`, sub: '' };
    default:
      return { main: step.type, sub: '' };
  }
}

function appendFeedItem(step) {
  const icon = STEP_ICONS[step.type] ?? '·';
  const { main, sub } = stepLabel(step);
  const li = document.createElement('li');
  li.className = 'record-feed-item';
  li.innerHTML = `
    <span class="record-feed-icon">${icon}</span>
    <span class="record-feed-label">${escapeHtml(main)}</span>
    ${sub ? `<span class="record-feed-sub">${escapeHtml(sub)}</span>` : ''}
  `;
  recordFeed.appendChild(li);
  li.scrollIntoView({ block: 'nearest' });
}

// ── Event listeners ────────────────────────────────────────────────────────────

// Start recording
btnStartRecord.addEventListener('click', async () => {
  const tabId = await getActiveTabId();
  if (!tabId) return alert('No hay una pestaña activa.');
  state.recordingStepCount = 0;
  stepCountEl.textContent = '0';
  recordFeed.innerHTML = '';   // clear feed from previous session
  await send(MSG.START_RECORDING, { tabId });
  setMode(RecordingState.RECORDING);
});

// Stop recording → show dialog
btnStopRecord.addEventListener('click', () => {
  showNameDialog();
});

// Cancel recording
btnCancelRecord.addEventListener('click', async () => {
  await send(MSG.ABORT_RECORDING);
  setMode(RecordingState.IDLE);
});

// Name dialog — save
btnDialogSave.addEventListener('click', async () => {
  const name = dialogNameInput.value.trim();
  if (!name) { dialogNameInput.focus(); return; }
  nameOverlay.classList.add('hidden');
  await send(MSG.STOP_RECORDING, { name });
  setMode(RecordingState.IDLE);
  await loadRecordings();
});

btnDialogCancel.addEventListener('click', () => {
  nameOverlay.classList.add('hidden');
});

dialogNameInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') btnDialogSave.click();
  if (e.key === 'Escape') btnDialogCancel.click();
});

function showNameDialog() {
  dialogNameInput.value = '';
  nameOverlay.classList.remove('hidden');
  dialogNameInput.focus();
}

// Run All
btnRunAll.addEventListener('click', async () => {
  const tabId = await getActiveTabId();
  if (!tabId) return alert('No hay una pestaña activa.');
  batchResults.innerHTML = '';
  batchSummary.textContent = '';
  batchSection.classList.add('hidden');
  await send(MSG.RUN_ALL, { tabId });
});

// Abort
btnAbort.addEventListener('click', () => {
  send(MSG.ABORT_RUN);
});

// Delegated click on recording list (run / delete)
recordingsList.addEventListener('click', async e => {
  const runBtn    = e.target.closest('.btn-run');
  const deleteBtn = e.target.closest('.btn-delete');

  if (runBtn) {
    const tabId = await getActiveTabId();
    if (!tabId) return alert('No hay una pestaña activa.');
    const rec = state.recordings.find(r => r.id === runBtn.dataset.id);
    if (!rec) return;
    stepsList.innerHTML = '';
    showRunSection(rec.title);
    await send(MSG.RUN_RECORDING, { recordingId: rec.id, tabId });
  }

  if (deleteBtn) {
    if (!confirm('¿Eliminar esta prueba?')) return;
    await send(MSG.DELETE_RECORDING, { recordingId: deleteBtn.dataset.id });
    await loadRecordings();
  }
});

// ── Incoming messages from service worker ──────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  const { type, payload } = msg;

  switch (type) {
    case MSG.RECORD_STEP:
      if (state.mode !== RecordingState.RECORDING) break;
      state.recordingStepCount++;
      stepCountEl.textContent = state.recordingStepCount;
      appendFeedItem(payload.step);
      break;

    case MSG.RECORDING_STATE:
      if (payload.recording === false) setMode(RecordingState.IDLE);
      break;

    case MSG.STEP_PROGRESS:
      addOrUpdateStep(payload);
      break;

    case MSG.RUN_COMPLETE: {
      const { passed, failedStep } = payload;
      progressBar.style.width = '100%';
      runTitle.textContent = passed ? '✅ Prueba completada' : '❌ Prueba fallida';
      if (!passed && failedStep) {
        runSubtitle.textContent = `Falló en el paso ${failedStep.index + 1}: ${failedStep.type}`;
      }
      setMode(RecordingState.IDLE);
      loadRecordings();
      break;
    }

    case MSG.BATCH_PROGRESS: {
      const { current, total, recordingTitle } = payload;
      showRunSection(recordingTitle);
      runSubtitle.textContent = `Prueba ${current} de ${total}`;
      break;
    }

    case MSG.BATCH_COMPLETE: {
      const { results } = payload;
      const passed = results.filter(r => r.passed).length;
      batchSummary.textContent = `${passed} de ${results.length} pruebas pasaron`;
      batchResults.innerHTML = results.map(r =>
        `<li class="batch-item">
          <span>${r.passed ? '✅' : '❌'}</span>
          <span>${escapeHtml(r.title)}</span>
        </li>`
      ).join('');
      batchSection.classList.remove('hidden');
      runSection.classList.add('hidden');
      setMode(RecordingState.IDLE);
      loadRecordings();
      break;
    }
  }
});

// ── Init ───────────────────────────────────────────────────────────────────────
async function loadRecordings() {
  const { recordings } = await send(MSG.GET_RECORDINGS) ?? { recordings: [] };

  // fetch last run for each recording and attach it
  const history = await send(MSG.GET_HISTORY) ?? { history: [] };
  const histMap = {};
  for (const run of (history.history ?? [])) {
    if (!histMap[run.recordingId]) histMap[run.recordingId] = run;
  }

  const enriched = (recordings ?? []).map(r => ({ ...r, lastRun: histMap[r.id] ?? null }));
  renderRecordings(enriched);
}

loadRecordings();
