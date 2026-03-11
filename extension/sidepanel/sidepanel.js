import { MSG, StepStatus, RecordingState } from "../shared/constants.js";

// ── State ──────────────────────────────────────────────────────────────────────
let state = {
  mode: RecordingState.IDLE, // 'idle' | 'recording' | 'replaying'
  recordingStepCount: 0,
  currentRunSteps: [],
  recordings: [],
  dynamicBreakpoints: new Set() // step indices the user has pinned via the hover ⏸ button
};

let editingRecording = null; // { id, title, steps, createdAt }
let pendingVariableStep = null; // { selectors, defaultValue, frame } — from SHOW_VARIABLE_DIALOG
let pendingPasteVariableStep = null; // { selectors, frame, variables } — from SHOW_PASTE_VARIABLE_DIALOG

// ── DOM refs ───────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const recordSection = $("record-section");
const recordIdle = $("record-idle");
const recordActive = $("record-active");
const btnStartRecord = $("btn-start-record");
const btnStopRecord = $("btn-stop-record");
const btnCancelRecord = $("btn-cancel-record");
const stepCountEl = $("step-count");
const recordFeed = $("record-feed");
const recordingsEmpty = $("recordings-empty");
const recordingsList = $("recordings-list");
const btnRunAll = $("btn-run-all");
const listSection = $("list-section");
const runSection = $("run-section");
const runTitle = $("run-title");
const runSubtitle = $("run-subtitle");
const progressBar = $("progress-bar");
const stepsList = $("steps-list");
const btnAbort = $("btn-abort");
const batchSection = $("batch-section");
const batchSummary = $("batch-summary");
const batchResults = $("batch-results");
const nameOverlay = $("name-overlay");
const dialogNameInput = $("dialog-name");
const btnDialogSave = $("btn-dialog-save");
const btnDialogCancel = $("btn-dialog-cancel");
const btnTheme = $("btn-theme");
const btnReset = $("btn-reset");
const btnNavA = $("btn-nav-a");
const btnNavV = $("btn-nav-v");
const btnHamburger = $("btn-hamburger");
const hamburgerMenu = $("hamburger-menu");
const btnBack = $("btn-back");
const speedBadges = document.querySelectorAll(".speed-badge");
const debugPanel = $("debug-panel");
const debugPanelText = $("debug-panel-text");
const btnDebugNext = $("btn-debug-next");
const btnDebugFinish = $("btn-debug-finish");
const editOverlay = $("edit-overlay");
const editTitleInput = $("edit-title");
const editStepsList = $("edit-steps-list");
const editStepCountEl = $("edit-step-count");
const btnEditSave = $("btn-edit-save");
const btnEditCancel = $("btn-edit-cancel");
const varOverlay = $("var-overlay");
const varNameInput = $("var-name");
const varValueInput = $("var-value");
const varPatternInput = $("var-pattern");
const btnVarSave = $("btn-var-save");
const btnVarCancel = $("btn-var-cancel");
const pasteVarOverlay = $("paste-var-overlay");
const pasteVarSelect = $("paste-var-select");
const pasteVarEmpty = $("paste-var-empty");
const btnPasteVarSave = $("btn-paste-var-save");
const btnPasteVarCancel = $("btn-paste-var-cancel");
const waitTimeOverlay = $("wait-time-overlay");
const waitDurationInput = $("wait-duration");
const btnWaitSave = $("btn-wait-save");
const btnWaitCancel = $("btn-wait-cancel");

// ── Theme toggle ───────────────────────────────────────────────────────────────
function applyTheme(light) {
  document.documentElement.classList.toggle("light", light);
  btnTheme.textContent = light ? "🌙" : "☀️";
}

const savedTheme = localStorage.getItem("theme");
applyTheme(savedTheme === "light");

btnTheme.addEventListener("click", () => {
  const isLight = document.documentElement.classList.toggle("light");
  btnTheme.textContent = isLight ? "🌙" : "☀️";
  localStorage.setItem("theme", isLight ? "light" : "dark");
});

// ── Hamburger menu ─────────────────────────────────────────────────────────────
btnHamburger.addEventListener("click", (e) => {
  e.stopPropagation();
  const open = hamburgerMenu.classList.toggle("hidden");
  btnHamburger.setAttribute("aria-expanded", String(!open));
});

document.addEventListener("click", (e) => {
  if (
    !hamburgerMenu.classList.contains("hidden") &&
    !hamburgerMenu.contains(e.target)
  ) {
    hamburgerMenu.classList.add("hidden");
    btnHamburger.setAttribute("aria-expanded", "false");
  }
});

// ── Step delay (speed badges) ──────────────────────────────────────────────────
let stepDelay = parseInt(localStorage.getItem("stepDelay") ?? "0", 10) || 0;

function applySpeedBadge(delayMs) {
  speedBadges.forEach((b) => {
    b.classList.toggle("active", Number(b.dataset.delay) === delayMs);
  });
}

applySpeedBadge(stepDelay);

speedBadges.forEach((badge) => {
  badge.addEventListener("click", () => {
    const value = Number(badge.dataset.delay);
    if (stepDelay === value) {
      // clicking the active badge deselects it (revert to default speed)
      stepDelay = 0;
      localStorage.removeItem("stepDelay");
    } else {
      stepDelay = value;
      localStorage.setItem("stepDelay", String(stepDelay));
    }
    applySpeedBadge(stepDelay);
  });
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
  if (!isoStr) return "";
  const diff = Date.now() - new Date(isoStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function formatDate(isoStr) {
  if (!isoStr) return "";
  return new Date(isoStr).toLocaleDateString("en", {
    day: "2-digit",
    month: "short"
  });
}

// ── Render recordings list ─────────────────────────────────────────────────────
function renderRecordings(recordings) {
  state.recordings = recordings;
  recordingsList.innerHTML = "";

  if (recordings.length === 0) {
    recordingsEmpty.classList.remove("hidden");
    btnRunAll.disabled = true;
    return;
  }

  recordingsEmpty.classList.add("hidden");
  btnRunAll.disabled = state.mode !== RecordingState.IDLE;

  for (const rec of recordings) {
    const li = document.createElement("li");
    li.className = "recording-card";
    li.dataset.id = rec.id;

    const lastRun = rec.lastRun;
    const badgeHtml = lastRun
      ? `<span class="badge ${lastRun.passed ? "badge-pass" : "badge-fail"}">
           ${lastRun.passed ? "✅ PASS" : "❌ FAIL"}
         </span>
         <span>${lastRun.completedSteps}/${lastRun.totalSteps} steps · ${timeAgo(lastRun.completedAt)}</span>`
      : `<span class="badge badge-none">Not run</span>`;

    li.innerHTML = `
      <div class="recording-card-header">
        <div>
          <div class="recording-title">${escapeHtml(rec.title)}</div>
          <div class="recording-meta">${rec.steps?.length ?? 0} steps · ${formatDate(rec.createdAt)}</div>
        </div>
        <button class="btn-icon btn-edit" data-id="${rec.id}" title="Edit">✏️</button>
      </div>
      <div class="last-run">${badgeHtml}</div>
      <div class="recording-card-actions">
        <button class="btn btn-primary btn-sm btn-run" data-id="${rec.id}">▶ Run</button>
        <button class="btn btn-ghost btn-sm btn-history" data-id="${rec.id}">🕐 History</button>
        <button class="btn btn-ghost btn-sm btn-delete" data-id="${rec.id}">🗑</button>
      </div>
      <div class="history-section hidden"></div>
    `;
    recordingsList.appendChild(li);
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Render step progress ───────────────────────────────────────────────────────
function addOrUpdateStep({
  stepIndex,
  total,
  status,
  stepType,
  stepDetail,
  durationMs,
  error,
  countdown
}) {
  // update progress bar
  const pct = total > 0 ? Math.round(((stepIndex + 1) / total) * 100) : 0;
  progressBar.style.width = `${pct}%`;
  runSubtitle.textContent = `Step ${stepIndex + 1} of ${total}`;

  // update or create step item
  let li = stepsList.querySelector(`[data-step="${stepIndex}"]`);
  if (!li) {
    li = document.createElement("li");
    li.className = "step-item";
    li.dataset.step = stepIndex;
    stepsList.appendChild(li);
  }

  const icons = { pending: "⏳", running: "🔄", passed: "✅", failed: "❌" };
  const dur =
    countdown != null ? `${countdown}s` : durationMs ? `${durationMs}ms` : "";

  const isBreakpoint = state.dynamicBreakpoints.has(stepIndex);
  li.className = `step-item ${status}`;
  li.innerHTML = `
    <span class="step-num">${stepIndex + 1}</span>
    <span class="step-icon">${icons[status] ?? "·"}</span>
    <span class="step-label">${stepType ?? ""}${stepDetail ? `<span class="step-detail"> ${escapeHtml(stepDetail)}</span>` : ""}</span>
    <span class="step-duration">${dur}</span>
    <button class="btn-pause-step${isBreakpoint ? " active" : ""}" data-step="${stepIndex}" title="Pause after this step">⏸</button>
    ${error ? `<div class="step-error">${escapeHtml(error)}</div>` : ""}
  `;

  // scroll to running step
  if (status === StepStatus.RUNNING) li.scrollIntoView({ block: "nearest" });
}

// ── UI state transitions ───────────────────────────────────────────────────────
function setMode(mode) {
  state.mode = mode;

  const isIdle = mode === RecordingState.IDLE;
  const isRecording = mode === RecordingState.RECORDING;
  const isReplaying = mode === RecordingState.REPLAYING;

  // record area — hide entire section (+ hr) when replaying to save space
  recordSection.classList.toggle("hidden", isReplaying);
  recordIdle.classList.toggle("hidden", !isIdle);
  recordActive.classList.toggle("hidden", !isRecording);

  // hide "My Tests" section while recording
  listSection.classList.toggle("hidden", isRecording);


  // horizontal card layout only while replaying
  recordingsList.classList.toggle("is-running", isReplaying);

  // run section
  if (!isReplaying) {
    runSection.classList.add("hidden");
    setActiveCard(null);
  }

  // disable run buttons while busy
  btnRunAll.disabled = !isIdle || state.recordings.length === 0;
  document.querySelectorAll(".btn-run").forEach((b) => (b.disabled = !isIdle));
}

function setActiveCard(recordingId) {
  recordingsList.querySelectorAll(".recording-card").forEach((c) => {
    c.classList.toggle("card-running", c.dataset.id === recordingId);
  });
  if (recordingId) {
    const card = recordingsList.querySelector(`[data-id="${recordingId}"]`);
    card?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "center"
    });
  }
}

function showRunSection(title) {
  runTitle.textContent = `Running: "${title}"`;
  runSubtitle.textContent = "";
  progressBar.style.width = "0%";
  stepsList.innerHTML = "";
  btnAbort.disabled = false;
  runSection.classList.remove("hidden");
  batchSection.classList.add("hidden");
  state.dynamicBreakpoints.clear();
  btnBack.classList.remove("invisible");
  setMode(RecordingState.REPLAYING);
}

// ── Step label helpers ─────────────────────────────────────────────────────────
const STEP_ICONS = {
  click: "🖱️",
  doubleClick: "🖱️",
  hover: "👆",
  selectOption: "🔽",
  change: "⌨️",
  navigate: "🔗",
  keyDown: "⌨️",
  keyUp: "⌨️",
  copy: "📋",
  paste: "📄",
  scroll: "📜",
  waitForElement: "⏳",
  waitForElementWithRefresh: "🔄",
  setViewport: "🖥️",
  copyVariable: "📌",
  pasteVariable: "📋",
  wait: "⏱️"
};

function stepLabel(step) {
  // Extract the most human-readable selector string available
  const sel = step.selectors?.flat?.().find(Boolean) ?? "";
  const ariaMatch = sel.match(/^aria\/(.+)/);
  const textMatch = sel.match(/^text\/(.+)/);
  const selectorHint =
    ariaMatch?.[1] ??
    textMatch?.[1] ??
    (sel.replace(/^(xpath|pierce|css)\//, "").slice(0, 30) || "");

  switch (step.type) {
    case "click":
    case "doubleClick":
      return {
        main: step.type === "doubleClick" ? "Double click" : "Click",
        sub: selectorHint
      };
    case "hover":
      return { main: "Hover", sub: selectorHint };
    case "selectOption":
      return {
        main: "Select",
        sub: `"${String(step.label ?? step.value ?? "").slice(0, 30)}"`
      };
    case "change":
      return {
        main: "Type",
        sub: `"${String(step.value ?? "").slice(0, 30)}"`
      };
    case "navigate":
      return {
        main: "Navigate",
        sub: (step.url ?? "").replace(/^https?:\/\//, "").slice(0, 40)
      };
    case "keyDown":
      return { main: `Key ↓ ${step.key}`, sub: "" };
    case "keyUp":
      return { main: `Key ↑ ${step.key}`, sub: "" };
    case "copy":
      return {
        main: "Copy",
        sub: `"${String(step.snapshotValue ?? "").slice(0, 30)}"`
      };
    case "paste":
      return { main: "Paste", sub: selectorHint };
    case "scroll":
      return { main: "Scroll", sub: "" };
    case "waitForElement":
      return { main: "Wait for element", sub: selectorHint };
    case "waitForElementWithRefresh":
      return { main: "Wait + refresh", sub: selectorHint };
    case "setViewport":
      return { main: `Viewport ${step.width}×${step.height}`, sub: "" };
    case "copyVariable":
      return {
        main: `Copy "${step.variableName}"`,
        sub: String(step.defaultValue ?? "").slice(0, 30)
      };
    case "pasteVariable":
      return { main: `Paste "${step.variableName}"`, sub: selectorHint };
    case "wait":
      return { main: `Wait ${(step.duration / 1000).toFixed(1)}s`, sub: "" };
    default:
      return { main: step.type, sub: "" };
  }
}

function appendFeedItem(step) {
  const icon = STEP_ICONS[step.type] ?? "·";
  const { main, sub } = stepLabel(step);
  const li = document.createElement("li");
  li.className = "record-feed-item";
  li.dataset.type = step.type;
  const num = recordFeed.children.length + 1;
  li.innerHTML = `
    <span class="step-num">${num}</span>
    <span class="record-feed-icon">${icon}</span>
    <span class="record-feed-label">${escapeHtml(main)}</span>
    ${sub ? `<span class="record-feed-sub">${escapeHtml(sub)}</span>` : ""}
    <button class="btn-delete-step" title="Delete action">×</button>
  `;
  recordFeed.appendChild(li);
  li.scrollIntoView({ block: "nearest" });
}

function renumberFeed() {
  Array.from(recordFeed.children).forEach((li, i) => {
    const numEl = li.querySelector(".step-num");
    if (numEl) numEl.textContent = i + 1;
  });
}

// ── History toggle ─────────────────────────────────────────────────────────────
async function toggleHistory(recordingId, historySection, toggleBtn) {
  if (!historySection.classList.contains("hidden")) {
    historySection.classList.add("hidden");
    toggleBtn.textContent = "🕐 History";
    return;
  }

  historySection.textContent = "Loading…";
  historySection.classList.remove("hidden");

  const res = (await send(MSG.GET_HISTORY, { recordingId })) ?? { history: [] };
  const runs = res.history ?? [];

  if (runs.length === 0) {
    historySection.innerHTML = '<p class="history-empty">No runs yet.</p>';
    toggleBtn.textContent = "▲ History";
    return;
  }

  historySection.innerHTML = runs
    .map((run) => {
      const failedInfo = run.failedStep
        ? `<div class="history-failed">Step ${run.failedStep.index + 1} (${run.failedStep.type}): ${escapeHtml(run.failedStep.error ?? "")}</div>`
        : "";
      return `<div class="history-item">
      <div class="history-item-row">
        <span class="badge ${run.passed ? "badge-pass" : "badge-fail"}">${run.passed ? "✅ PASS" : "❌ FAIL"}</span>
        <span class="history-meta">${run.completedSteps}/${run.totalSteps} steps · ${timeAgo(run.completedAt)}</span>
      </div>
      ${failedInfo}
    </div>`;
    })
    .join("");

  toggleBtn.textContent = "▲ History";
}

// ── Edit overlay ───────────────────────────────────────────────────────────────
function openEditOverlay(rec) {
  editingRecording = { ...rec, steps: [...rec.steps] };
  editTitleInput.value = rec.title;
  renderEditSteps(editingRecording.steps);
  editOverlay.classList.remove("hidden");
  editTitleInput.focus();
}

function renderEditSteps(steps) {
  editStepCountEl.textContent = steps.length;
  editStepsList.innerHTML = "";
  steps.forEach((step, i) => {
    const icon = STEP_ICONS[step.type] ?? "·";
    const { main, sub } = stepLabel(step);
    const li = document.createElement("li");
    li.className = "edit-step-item";
    li.dataset.index = i;

    // For step types with an editable value, render an inline input instead of
    // a static sub-label so the user can update the value directly.
    let editableHtml;
    if (step.type === "change") {
      editableHtml = `<input class="edit-step-value" type="text"
        data-index="${i}" data-field="value"
        value="${escapeHtml(step.value ?? "")}" placeholder="(empty)" />`;
    } else if (step.type === "navigate") {
      editableHtml = `<input class="edit-step-value" type="text"
        data-index="${i}" data-field="url"
        value="${escapeHtml(step.url ?? "")}" />`;
    } else if (step.type === "wait") {
      const secs = ((step.duration ?? 0) / 1000).toFixed(1);
      editableHtml = `<input class="edit-step-value edit-step-value--narrow" type="number"
        data-index="${i}" data-field="duration"
        value="${secs}" min="0.1" step="0.1" /><span class="edit-step-unit">s</span>`;
    } else {
      editableHtml = sub
        ? `<span class="edit-step-sub">${escapeHtml(sub)}</span>`
        : "";
    }

    li.innerHTML = `
      <span class="edit-step-num">${i + 1}</span>
      <span class="edit-step-icon">${icon}</span>
      <span class="edit-step-label">${escapeHtml(main)}</span>
      ${editableHtml}
      <button class="btn-debug-step${step.debug ? " active" : ""}" data-index="${i}" title="Pause replay here">⏸</button>
      <button class="btn-insert-from-step" data-index="${i}" title="Insert steps here (keeps following steps)">⏺</button>
      <button class="btn-continue-from-step" data-index="${i}" title="Record from here (removes following steps)">✂</button>
      <button class="btn-delete-edit-step" title="Delete step">×</button>
    `;
    editStepsList.appendChild(li);
  });
}

// Delete a step from the feed and from the SW recording state
recordFeed.addEventListener("click", async (e) => {
  const btn = e.target.closest(".btn-delete-step");
  if (!btn) return;
  const li = btn.closest(".record-feed-item");
  const index = Array.from(recordFeed.children).indexOf(li);
  if (index < 0) return;
  await send(MSG.DELETE_STEP, { index });
  li.remove();
  state.recordingStepCount = Math.max(0, state.recordingStepCount - 1);
  stepCountEl.textContent = state.recordingStepCount;
  renumberFeed();
});

recordFeed.addEventListener("dblclick", (e) => {
  const li = e.target.closest(".record-feed-item");
  if (!li || li.dataset.type !== "change") return;
  if (li.querySelector(".record-feed-edit")) return; // already editing

  const index = Array.from(recordFeed.children).indexOf(li);
  if (index < 0) return;

  const subEl = li.querySelector(".record-feed-sub");
  // Extract raw value from the displayed label, e.g. `"hello"` → `hello`
  const rawValue = subEl ? subEl.textContent.replace(/^"|"$/g, "") : "";

  const input = document.createElement("input");
  input.className = "record-feed-edit";
  input.type = "text";
  input.value = rawValue;
  if (subEl) subEl.replaceWith(input);
  else li.insertBefore(input, li.querySelector(".btn-delete-step"));
  input.focus();
  input.select();

  let settled = false;

  function confirm() {
    if (settled) return;
    settled = true;
    const newValue = input.value;
    send(MSG.UPDATE_RECORDING_STEP, { index, value: newValue });
    const newSub = document.createElement("span");
    newSub.className = "record-feed-sub";
    newSub.textContent = `"${newValue.slice(0, 30)}"`;
    input.replaceWith(newSub);
  }

  function cancel() {
    if (settled) return;
    settled = true;
    if (subEl) input.replaceWith(subEl);
    else input.remove();
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      confirm();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  });
  input.addEventListener("blur", cancel);
});

// ── Event listeners ────────────────────────────────────────────────────────────

// Start recording
btnStartRecord.addEventListener("click", async () => {
  const tabId = await getActiveTabId();
  if (!tabId) return alert("No active tab found.");
  state.recordingStepCount = 0;
  stepCountEl.textContent = "0";
  recordFeed.innerHTML = ""; // clear feed from previous session
  setMode(RecordingState.RECORDING); // set BEFORE sending so RECORD_STEP arrives in the right mode
  await send(MSG.START_RECORDING, { tabId });
});

// Stop recording → show dialog
btnStopRecord.addEventListener("click", () => {
  showNameDialog();
});

// Cancel recording
btnCancelRecord.addEventListener("click", async () => {
  await send(MSG.ABORT_RECORDING);
  setMode(RecordingState.IDLE);
});

// Name dialog — save
btnDialogSave.addEventListener("click", async () => {
  const name = dialogNameInput.value.trim();
  if (!name) {
    dialogNameInput.focus();
    return;
  }
  nameOverlay.classList.add("hidden");
  await send(MSG.STOP_RECORDING, { name });
  setMode(RecordingState.IDLE);
  await loadRecordings();
});

btnDialogCancel.addEventListener("click", () => {
  nameOverlay.classList.add("hidden");
});

dialogNameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") btnDialogSave.click();
  if (e.key === "Escape") btnDialogCancel.click();
});

function showNameDialog() {
  dialogNameInput.value = "";
  nameOverlay.classList.remove("hidden");
  dialogNameInput.focus();
}

// Run All
btnRunAll.addEventListener("click", async () => {
  const tabId = await getActiveTabId();
  if (!tabId) return alert("No active tab found.");
  batchResults.innerHTML = "";
  batchSummary.textContent = "";
  batchSection.classList.add("hidden");
  await send(MSG.RUN_ALL, { tabId, stepDelay: stepDelay || undefined });
});

// Reset — aborts any active run, then clears all stuck state in the service worker
btnNavA.addEventListener("click", () => {
  chrome.tabs.update({
    url: "https://appriserisksolutions--appriseuat.sandbox.lightning.force.com/lightning/n/Quality_Review"
  });
});

btnNavV.addEventListener("click", () => {
  chrome.tabs.update({
    url: "https://vxtest.valex.com.au/valfirm/job-order-new.php"
  });
});

btnBack.addEventListener("click", async () => {
  if (state.mode === RecordingState.REPLAYING) {
    if (!confirm("A test is still running. Stop it and go back?")) return;
    await send(MSG.ABORT_RUN);
  }
  btnBack.classList.add("invisible");
  runSection.classList.add("hidden");
  batchSection.classList.add("hidden");
  setMode(RecordingState.IDLE);
});

btnReset.addEventListener("click", async () => {
  await send(MSG.ABORT_RUN).catch(console.error);
  await send(MSG.RESET_STATE);
  runSection.classList.add("hidden");
  batchSection.classList.add("hidden");
  btnBack.classList.add("invisible");
  setMode(RecordingState.IDLE);
});

// Abort
btnAbort.addEventListener("click", () => {
  send(MSG.ABORT_RUN);
  // Give immediate visual feedback while waiting for RUN_COMPLETE from the SW
  runTitle.textContent = "Stopping…";
  btnAbort.disabled = true;
});

// Pause-step button on step items during replay
stepsList.addEventListener("click", (e) => {
  const btn = e.target.closest(".btn-pause-step");
  if (!btn) return;
  const stepIndex = Number(btn.dataset.step);
  if (state.dynamicBreakpoints.has(stepIndex)) {
    state.dynamicBreakpoints.delete(stepIndex);
    btn.classList.remove("active");
  } else {
    state.dynamicBreakpoints.add(stepIndex);
    btn.classList.add("active");
    send(MSG.SET_DYNAMIC_BREAKPOINT, { stepIndex });
  }
});

// Delegated click on recording list (run / delete / edit / history)
recordingsList.addEventListener("click", async (e) => {
  const runBtn = e.target.closest(".btn-run");
  const deleteBtn = e.target.closest(".btn-delete");
  const editBtn = e.target.closest(".btn-edit");
  const histBtn = e.target.closest(".btn-history");

  if (runBtn) {
    const tabId = await getActiveTabId();
    if (!tabId) return alert("No active tab found.");
    const rec = state.recordings.find((r) => r.id === runBtn.dataset.id);
    if (!rec) return;
    stepsList.innerHTML = "";
    showRunSection(rec.title);
    setActiveCard(rec.id);
    await send(MSG.RUN_RECORDING, {
      recordingId: rec.id,
      tabId,
      stepDelay: stepDelay || undefined
    });
  }

  if (deleteBtn) {
    if (!confirm("Delete this test?")) return;
    await send(MSG.DELETE_RECORDING, { recordingId: deleteBtn.dataset.id });
    await loadRecordings();
  }

  if (editBtn) {
    const rec = state.recordings.find((r) => r.id === editBtn.dataset.id);
    if (rec) openEditOverlay(rec);
  }

  if (histBtn) {
    const card = histBtn.closest(".recording-card");
    const historySection = card.querySelector(".history-section");
    await toggleHistory(histBtn.dataset.id, historySection, histBtn);
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
      debugPanel.classList.add("hidden");
      const { passed, failedStep } = payload;
      progressBar.style.width = "100%";
      runTitle.textContent = passed ? "✅ Test passed" : "❌ Test failed";
      if (!passed && failedStep) {
        runSubtitle.textContent = `Step ${failedStep.index + 1} (${failedStep.type}): ${failedStep.error ?? ""}`;
      }
      // Stay in the run view so the user can review all steps.
      // Just re-enable buttons without resetting the layout.
      state.mode = RecordingState.IDLE;
      btnAbort.disabled = true;
      btnRunAll.disabled = state.recordings.length === 0;
      document
        .querySelectorAll(".btn-run")
        .forEach((b) => (b.disabled = false));
      loadRecordings();
      break;
    }

    case MSG.BATCH_PROGRESS: {
      const { current, total, recordingId, recordingTitle } = payload;
      showRunSection(recordingTitle);
      runSubtitle.textContent = `Test ${current} of ${total}`;
      setActiveCard(recordingId ?? null);
      break;
    }

    case MSG.BATCH_COMPLETE: {
      const { results } = payload;
      const passed = results.filter((r) => r.passed).length;
      batchSummary.textContent = `${passed} of ${results.length} tests passed`;
      batchResults.innerHTML = results
        .map(
          (r) =>
            `<li class="batch-item">
          <span>${r.passed ? "✅" : "❌"}</span>
          <span>${escapeHtml(r.title)}</span>
        </li>`
        )
        .join("");
      batchSection.classList.remove("hidden");
      runSection.classList.add("hidden");
      // Stay in the run view; just re-enable buttons without resetting the layout.
      state.mode = RecordingState.IDLE;
      btnAbort.disabled = true;
      btnRunAll.disabled = state.recordings.length === 0;
      document
        .querySelectorAll(".btn-run")
        .forEach((b) => (b.disabled = false));
      loadRecordings();
      break;
    }

    case MSG.SHOW_VARIABLE_DIALOG:
      pendingVariableStep = payload; // { selectors, defaultValue, valuePattern, elementTag, frame }
      varNameInput.value = "";
      varValueInput.value = payload.defaultValue ?? "";
      varPatternInput.value = payload.valuePattern ?? "";
      varOverlay.classList.remove("hidden");
      varNameInput.focus();
      break;

    case MSG.SHOW_PASTE_VARIABLE_DIALOG: {
      pendingPasteVariableStep = payload; // { selectors, frame, variables: [{name, defaultValue}] }
      const vars = payload.variables ?? [];
      pasteVarSelect.innerHTML = vars
        .map(
          (v) =>
            `<option value="${escapeHtml(v.name)}" data-default="${escapeHtml(v.defaultValue ?? "")}">${escapeHtml(v.name)}</option>`
        )
        .join("");
      pasteVarSelect.classList.toggle("hidden", vars.length === 0);
      pasteVarEmpty.classList.toggle("hidden", vars.length > 0);
      btnPasteVarSave.disabled = vars.length === 0;
      pasteVarOverlay.classList.remove("hidden");
      break;
    }

    case MSG.SHOW_WAIT_DIALOG:
      waitDurationInput.value = "1";
      waitTimeOverlay.classList.remove("hidden");
      waitDurationInput.focus();
      break;

    case MSG.DEBUG_PAUSE: {
      const { stepIndex, total, stepType } = payload;
      debugPanelText.textContent = `Paused after step ${stepIndex + 1} of ${total} (${stepType})`;
      debugPanel.classList.remove("hidden");
      break;
    }
  }
});

// ── Debug panel buttons ─────────────────────────────────────────────────────────
btnDebugNext.addEventListener("click", () => {
  debugPanel.classList.add("hidden");
  send(MSG.DEBUG_NEXT);
});

btnDebugFinish.addEventListener("click", () => {
  debugPanel.classList.add("hidden");
  send(MSG.DEBUG_FINISH);
});

// ── Variable dialog event listeners ────────────────────────────────────────────

btnVarSave.addEventListener("click", async () => {
  const name = varNameInput.value.trim();
  if (!name) {
    varNameInput.focus();
    return;
  }

  const step = {
    type: "copyVariable",
    target: "main",
    variableName: name,
    defaultValue: varValueInput.value,
    valuePattern: varPatternInput.value.trim(),
    elementTag: pendingVariableStep?.elementTag ?? "",
    selectors: pendingVariableStep?.selectors ?? [],
    ...(pendingVariableStep?.frame?.length
      ? { frame: pendingVariableStep.frame }
      : {})
  };

  await send(MSG.ADD_RECORDING_STEP, { step });

  // Add to the live feed directly (SW does not re-broadcast ADD_RECORDING_STEP)
  state.recordingStepCount++;
  stepCountEl.textContent = state.recordingStepCount;
  appendFeedItem(step);

  varOverlay.classList.add("hidden");
  pendingVariableStep = null;
});

btnVarCancel.addEventListener("click", () => {
  varOverlay.classList.add("hidden");
  pendingVariableStep = null;
});

varNameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") btnVarSave.click();
  if (e.key === "Escape") btnVarCancel.click();
});

// ── Paste variable dialog event listeners ──────────────────────────────────────

btnPasteVarSave.addEventListener("click", async () => {
  const name = pasteVarSelect.value;
  if (!name) return;

  const selectedOption = pasteVarSelect.selectedOptions[0];
  const fallbackValue = selectedOption?.dataset.default ?? "";

  const step = {
    type: "pasteVariable",
    target: "main",
    variableName: name,
    fallbackValue,
    selectors: pendingPasteVariableStep?.selectors ?? [],
    ...(pendingPasteVariableStep?.frame?.length
      ? { frame: pendingPasteVariableStep.frame }
      : {})
  };

  await send(MSG.ADD_RECORDING_STEP, { step });

  state.recordingStepCount++;
  stepCountEl.textContent = state.recordingStepCount;
  appendFeedItem(step);

  pasteVarOverlay.classList.add("hidden");
  pendingPasteVariableStep = null;
});

btnPasteVarCancel.addEventListener("click", () => {
  pasteVarOverlay.classList.add("hidden");
  pendingPasteVariableStep = null;
});

// ── Wait for time dialog event listeners ───────────────────────────────────────

btnWaitSave.addEventListener("click", async () => {
  const seconds = parseFloat(waitDurationInput.value);
  if (!seconds || seconds <= 0) {
    waitDurationInput.focus();
    return;
  }

  const step = {
    type: "wait",
    target: "main",
    duration: Math.round(seconds * 1000)
  };

  await send(MSG.ADD_RECORDING_STEP, { step });

  state.recordingStepCount++;
  stepCountEl.textContent = state.recordingStepCount;
  appendFeedItem(step);

  waitTimeOverlay.classList.add("hidden");
});

btnWaitCancel.addEventListener("click", () => {
  waitTimeOverlay.classList.add("hidden");
});

waitDurationInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") btnWaitSave.click();
  if (e.key === "Escape") btnWaitCancel.click();
});

// ── Edit overlay event listeners ───────────────────────────────────────────────

// Delete a step from the local copy while editing
editStepsList.addEventListener("click", (e) => {
  const btn = e.target.closest(".btn-delete-edit-step");
  if (!btn || !editingRecording) return;
  const li = btn.closest(".edit-step-item");
  const idx = Number(li.dataset.index);
  editingRecording.steps.splice(idx, 1);
  renderEditSteps(editingRecording.steps);
});

// Insert steps after a specific step (keeps the following steps)
editStepsList.addEventListener("click", async (e) => {
  const btn = e.target.closest(".btn-insert-from-step");
  if (!btn || !editingRecording) return;
  const idx = Number(btn.dataset.index);
  const steps = editingRecording.steps.slice(0, idx + 1);
  const remainingSteps = editingRecording.steps.slice(idx + 1);

  const tabId = await getActiveTabId();
  if (!tabId) return alert("No active tab found.");

  editOverlay.classList.add("hidden");
  editingRecording = null;

  recordFeed.innerHTML = "";
  state.recordingStepCount = steps.length;
  stepCountEl.textContent = steps.length;
  setMode(RecordingState.RECORDING);
  steps.forEach((step) => appendFeedItem(step));

  await send(MSG.CONTINUE_RECORDING, { tabId, steps, remainingSteps });
});

// Continue recording from a specific step (removes following steps)
editStepsList.addEventListener("click", async (e) => {
  const btn = e.target.closest(".btn-continue-from-step");
  if (!btn || !editingRecording) return;
  const idx = Number(btn.dataset.index);
  const steps = editingRecording.steps.slice(0, idx + 1);

  const tabId = await getActiveTabId();
  if (!tabId) return alert("No active tab found.");

  editOverlay.classList.add("hidden");
  editingRecording = null;

  recordFeed.innerHTML = "";
  state.recordingStepCount = steps.length;
  stepCountEl.textContent = steps.length;
  setMode(RecordingState.RECORDING);
  steps.forEach((step) => appendFeedItem(step));

  await send(MSG.CONTINUE_RECORDING, { tabId, steps, remainingSteps: [] });
});

// Debugger toggle — mark/unmark a step as a breakpoint
editStepsList.addEventListener("click", (e) => {
  const btn = e.target.closest(".btn-debug-step");
  if (!btn || !editingRecording) return;
  const idx = Number(btn.dataset.index);
  const step = editingRecording.steps[idx];
  if (!step) return;
  step.debug = !step.debug;
  btn.classList.toggle("active", step.debug);
});

// Inline value editing — update the step object as the user types
editStepsList.addEventListener("input", (e) => {
  const input = e.target.closest(".edit-step-value");
  if (!input || !editingRecording) return;
  const idx = Number(input.dataset.index);
  const step = editingRecording.steps[idx];
  if (!step) return;

  const field = input.dataset.field;
  if (field === "value") {
    step.value = input.value;
  } else if (field === "url") {
    step.url = input.value;
    if (step.assertedEvents?.[0]) step.assertedEvents[0].url = input.value;
  } else if (field === "duration") {
    const secs = parseFloat(input.value);
    if (!isNaN(secs) && secs > 0) step.duration = Math.round(secs * 1000);
  }
});

btnEditSave.addEventListener("click", async () => {
  const title = editTitleInput.value.trim();
  if (!title) {
    editTitleInput.focus();
    return;
  }
  editingRecording.title = title;
  await send(MSG.UPDATE_RECORDING, {
    id: editingRecording.id,
    title: editingRecording.title,
    steps: editingRecording.steps,
    createdAt: editingRecording.createdAt
  });
  editOverlay.classList.add("hidden");
  editingRecording = null;
  await loadRecordings();
});

btnEditCancel.addEventListener("click", () => {
  editOverlay.classList.add("hidden");
  editingRecording = null;
});

editTitleInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") btnEditSave.click();
  if (e.key === "Escape") btnEditCancel.click();
});

// ── Init ───────────────────────────────────────────────────────────────────────
async function loadRecordings() {
  const { recordings } = (await send(MSG.GET_RECORDINGS)) ?? { recordings: [] };

  // fetch last run for each recording and attach it
  const history = (await send(MSG.GET_HISTORY)) ?? { history: [] };
  const histMap = {};
  for (const run of history.history ?? []) {
    if (!histMap[run.recordingId]) histMap[run.recordingId] = run;
  }

  const enriched = (recordings ?? []).map((r) => ({
    ...r,
    lastRun: histMap[r.id] ?? null
  }));
  renderRecordings(enriched);
}

// On open: reset any stale SW state (e.g. after a page refresh or extension reload),
// then load the recordings list.
send(MSG.RESET_STATE)
  .catch(console.error)
  .finally(() => loadRecordings());
