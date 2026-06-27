const folderButton = document.getElementById('folderButton');
const startButton = document.getElementById('startButton');
const stopButton = document.getElementById('stopButton');
const forgetButton = document.getElementById('forgetButton');
const clearLogButton = document.getElementById('clearLogButton');
const qualitySelect = document.getElementById('qualitySelect');
const presetSelect = document.getElementById('presetSelect');
const statusPill = document.getElementById('statusPill');
const folderMeta = document.getElementById('folderMeta');
const folderPath = document.getElementById('folderPath');
const fileCount = document.getElementById('fileCount');
const optionGrid = document.getElementById('optionGrid');
const actionRow = document.getElementById('actionRow');
const maintenanceRow = document.getElementById('maintenanceRow');
const historySummary = document.getElementById('historySummary');
const statGrid = document.getElementById('statGrid');
const progressPanel = document.getElementById('progressPanel');
const logPanel = document.getElementById('logPanel');
const queuedValue = document.getElementById('queuedValue');
const completedValue = document.getElementById('completedValue');
const savedValue = document.getElementById('savedValue');
const failedValue = document.getElementById('failedValue');
const currentFile = document.getElementById('currentFile');
const progressText = document.getElementById('progressText');
const progressBar = document.getElementById('progressBar');
const logArea = document.getElementById('logArea');

let currentState = null;
let hasLogEntries = false;

const statusLabels = {
  idle: 'Idle',
  scanning: 'Scanning',
  ready: 'Ready',
  running: 'Running',
  stopping: 'Stopping',
  done: 'Done',
  error: 'Needs attention',
};

folderButton.addEventListener('click', async () => {
  await window.api.selectFolder();
});

startButton.addEventListener('click', () => {
  startProcessing();
});

stopButton.addEventListener('click', () => {
  window.api.stop();
});

forgetButton.addEventListener('click', async () => {
  const confirmed = window.confirm(
    'Forget the processed history for this app? Existing video files will not be changed.',
  );

  if (confirmed) {
    await window.api.clearProcessedHistory();
  }
});

clearLogButton.addEventListener('click', () => {
  logArea.value = '';
  hasLogEntries = false;
  updateVisibility(currentState);
});

qualitySelect.addEventListener('change', updateOptionState);
presetSelect.addEventListener('change', updateOptionState);

window.api.onLog((message) => {
  log(message);
});

window.api.onState((state) => {
  updateState(state);
});

window.api.getState().then(updateState);

async function startProcessing() {
  await window.api.start({
    crf: Number(qualitySelect.value),
    preset: presetSelect.value,
  });
}

function updateState(state) {
  currentState = state;

  const status = state.status || 'idle';
  const busy = status === 'running' || status === 'stopping' || status === 'scanning';
  const processing = status === 'running' || status === 'stopping';
  const canStart = Boolean(state.dir) && !busy && state.pendingFiles > 0;
  const completed = state.completedThisRun || 0;
  const runTotal = state.runTotal || 0;
  const percent = runTotal ? Math.min(100, Math.round((completed / runTotal) * 100)) : 0;

  statusPill.textContent = statusLabels[status] || status;
  statusPill.dataset.status = status;

  folderPath.textContent = state.dir || 'No folder selected';
  fileCount.textContent = buildFileCountText(state);
  historySummary.textContent = buildHistoryText(state.historyCount || 0);

  queuedValue.textContent = String(state.pendingFiles || 0);
  completedValue.textContent = runTotal ? `${completed}/${runTotal}` : '0/0';
  savedValue.textContent = `${formatMb(state.spaceSavedMb || 0)} MB`;
  failedValue.textContent = String(state.failedThisRun || 0);

  currentFile.textContent = state.currentFile || getIdleFileText(state);
  progressText.textContent = runTotal ? `${percent}%` : '0%';
  progressBar.style.width = `${percent}%`;

  folderButton.disabled = busy;
  startButton.disabled = !canStart;
  stopButton.disabled = !processing;
  forgetButton.disabled = busy || !state.historyCount;
  qualitySelect.disabled = busy;
  presetSelect.disabled = busy;
  updateOptionState();
  updateVisibility(state);
}

function updateOptionState() {
  if (!currentState) {
    return;
  }

  const busy = ['running', 'stopping', 'scanning'].includes(currentState.status);
  qualitySelect.disabled = busy;
  presetSelect.disabled = busy;
}

function updateVisibility(state) {
  if (!state) {
    return;
  }

  const status = state.status || 'idle';
  const hasFolder = Boolean(state.dir);
  const busy = ['running', 'stopping', 'scanning'].includes(status);
  const processing = status === 'running' || status === 'stopping';
  const hasRun = state.runTotal > 0 || state.completedThisRun > 0;
  const hasUsefulStats = processing || hasRun || status === 'error';
  const shouldShowLog = processing || status === 'error' || (hasRun && hasLogEntries);

  statusPill.hidden = status === 'idle';
  folderMeta.hidden = !hasFolder && status !== 'scanning';
  optionGrid.hidden = !hasFolder || busy || state.pendingFiles === 0;
  startButton.hidden = !hasFolder || busy || state.pendingFiles === 0;
  stopButton.hidden = !processing;
  actionRow.hidden = startButton.hidden && stopButton.hidden;
  forgetButton.hidden = !state.historyCount || busy;
  maintenanceRow.hidden = forgetButton.hidden;
  statGrid.hidden = !hasUsefulStats;
  progressPanel.hidden = !(processing || hasRun || status === 'error');
  logPanel.hidden = !shouldShowLog;
  clearLogButton.hidden = !hasLogEntries;
}

function buildFileCountText(state) {
  if (state.status === 'scanning') {
    return 'Scanning folder...';
  }

  if (!state.totalFiles) {
    return '0 videos found';
  }

  const parts = [`${state.totalFiles} videos found`, `${state.pendingFiles} ready`];

  if (state.skippedKnown) {
    parts.push(`${state.skippedKnown} already processed`);
  }

  if (state.skippedGenerated) {
    parts.push(`${state.skippedGenerated} ignored`);
  }

  return parts.join(' | ');
}

function buildHistoryText(historyCount) {
  if (historyCount === 1) {
    return '1 processed file is remembered.';
  }

  return `${historyCount} processed files are remembered.`;
}

function getIdleFileText(state) {
  if (state.status === 'done') {
    return 'Batch complete';
  }

  if (state.status === 'ready' && state.pendingFiles > 0) {
    return 'Ready to process';
  }

  if (state.status === 'error') {
    return 'Check the log';
  }

  return 'No active file';
}

function formatMb(value) {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: value >= 10 ? 0 : 1,
  }).format(value);
}

function log(message) {
  const timestamp = new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  hasLogEntries = true;
  logArea.value += `[${timestamp}] ${message}\n`;
  logArea.scrollTop = logArea.scrollHeight;
  updateVisibility(currentState);
}
