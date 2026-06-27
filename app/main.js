const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { globSync } = require('glob');
const os = require('os');
const { renameSync, statSync, unlinkSync } = require('fs');
const { spawn } = require('child_process');
const { utimes } = require('utimes');
const ffPath = require('ffmpeg-static');
const crypto = require('crypto');

const VIDEO_EXTENSIONS = ['mp4', 'mts', 'm2ts', 'flv', 'm4v'];
const VIDEO_GLOB = `**/*.{${VIDEO_EXTENSIONS.join(',')}}`;
const DEFAULT_OPTIONS = { crf: 23, preset: 'slow' };
const ALLOWED_CRF = new Set([20, 23, 26]);
const ALLOWED_PRESETS = new Set([
  'ultrafast',
  'superfast',
  'veryfast',
  'faster',
  'fast',
  'medium',
  'slow',
  'slower',
  'veryslow',
]);

let win;
let dir = null;
let files = [];
let processedFiles = new Set();
let failedFiles = new Set();
let oneWayHashCache = new Map();
let working = false;
let stopRequested = false;
let childFfmpeg = null;
let appStatus = 'idle';
let currentFile = null;
let spaceSavedMb = 0;
let activeOptions = { ...DEFAULT_OPTIONS };
let runStats = createRunStats();

const userDataPath = app.getPath('userData');
const processedFilesPath = path.join(userDataPath, 'processedFiles.txt');

loadProcessedFiles();

function createRunStats(total = 0) {
  return {
    total,
    completed: 0,
    compressed: 0,
    skippedLarger: 0,
    failed: 0,
  };
}

function loadProcessedFiles() {
  if (!fs.existsSync(processedFilesPath)) {
    return;
  }

  try {
    const data = fs.readFileSync(processedFilesPath, 'utf8');
    processedFiles = new Set(
      data
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    );
  } catch (err) {
    console.error('Error reading processed files', err);
  }
}

function saveProcessedFiles() {
  try {
    fs.writeFileSync(processedFilesPath, Array.from(processedFiles).join('\n'));
  } catch (err) {
    console.error('Error saving processed files', err);
  }
}

function oneWayHash(value) {
  if (oneWayHashCache.has(value)) {
    return oneWayHashCache.get(value);
  }

  const result = crypto.createHash('sha256').update(value).digest('hex');
  oneWayHashCache.set(value, result);
  return result;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 760,
    minHeight: 620,
    title: 'batchviproc',
    icon: path.join(__dirname, 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, 'index.html'));
  win.on('closed', () => {
    win = null;
  });
}

app.whenReady().then(createWindow);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (childFfmpeg) {
    stopRequested = true;
    childFfmpeg.kill();
  }
});

function send(name, message) {
  if (!win || win.isDestroyed()) {
    return;
  }

  win.webContents.send(name, message);
}

function log(message) {
  send('proc-log', String(message));
}

function getDisplayName(filePath) {
  if (!filePath) {
    return '';
  }

  if (!dir) {
    return path.basename(filePath);
  }

  return path.relative(dir, filePath) || path.basename(filePath);
}

function isGeneratedVideoName(filePath) {
  const baseName = path.basename(filePath).toLowerCase();
  return (
    baseName.includes('.batchviproc.') ||
    baseName.includes('.tmp.') ||
    baseName.includes('-h264.')
  );
}

function isKnownProcessed(filePath) {
  return processedFiles.has(oneWayHash(filePath));
}

function canProcessFile(filePath) {
  return (
    !isGeneratedVideoName(filePath) &&
    !isKnownProcessed(filePath) &&
    !failedFiles.has(filePath)
  );
}

function getPendingFiles() {
  return files.filter(canProcessFile);
}

function countKnownFiles() {
  return files.filter(
    (filePath) => !isGeneratedVideoName(filePath) && isKnownProcessed(filePath),
  ).length;
}

function countGeneratedFiles() {
  return files.filter(isGeneratedVideoName).length;
}

function getState() {
  return {
    status: appStatus,
    working,
    dir,
    totalFiles: files.length,
    pendingFiles: getPendingFiles().length,
    skippedKnown: countKnownFiles(),
    skippedGenerated: countGeneratedFiles(),
    historyCount: processedFiles.size,
    processedFilesPath,
    runTotal: runStats.total,
    completedThisRun: runStats.completed,
    compressedThisRun: runStats.compressed,
    skippedLargerThisRun: runStats.skippedLarger,
    failedThisRun: runStats.failed,
    spaceSavedMb: roundNumber(spaceSavedMb),
    currentFile: getDisplayName(currentFile),
    options: activeOptions,
  };
}

function sendState() {
  const state = getState();
  send('proc-state', state);
  return state;
}

function roundNumber(value) {
  return Math.round(value * 10) / 10;
}

function sortFilesBySizeDesc(filePaths) {
  return filePaths
    .map((filePath) => {
      try {
        const stats = fs.statSync(filePath);
        return { filePath, size: stats.size };
      } catch (err) {
        log(`Could not read ${filePath}: ${err.message}`);
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.size - a.size)
    .map((file) => file.filePath);
}

function normalizeOptions(options = {}) {
  const crf = Number(options.crf);
  const preset = String(options.preset || DEFAULT_OPTIONS.preset);

  return {
    crf: ALLOWED_CRF.has(crf) ? crf : DEFAULT_OPTIONS.crf,
    preset: ALLOWED_PRESETS.has(preset) ? preset : DEFAULT_OPTIONS.preset,
  };
}

function getFfmpegPath() {
  return ffPath.replace('app.asar', 'app.asar.unpacked');
}

function getTempName(input) {
  const parsed = path.parse(input);
  return path.join(parsed.dir, `${parsed.name}.batchviproc${parsed.ext}`);
}

function removeFileIfExists(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      unlinkSync(filePath);
    }
  } catch (err) {
    log(`Could not remove temporary file ${filePath}: ${err.message}`);
  }
}

function addProcessedFile(filePath) {
  processedFiles.add(oneWayHash(filePath));
  saveProcessedFiles();
}

async function scanFiles() {
  const matches = globSync(VIDEO_GLOB, {
    cwd: dir,
    nodir: true,
    nocase: true,
  });

  const nextFiles = Array.from(
    new Set(matches.map((filePath) => path.resolve(dir, filePath))),
  );

  files = sortFilesBySizeDesc(nextFiles);
  failedFiles = new Set();
  runStats = createRunStats();
  currentFile = null;
  spaceSavedMb = 0;

  log(`Found ${files.length} videos in ${dir}`);

  const knownCount = countKnownFiles();
  if (knownCount > 0) {
    log(`${knownCount} videos are already in the processed history`);
  }

  const generatedCount = countGeneratedFiles();
  if (generatedCount > 0) {
    log(`${generatedCount} generated or temporary files will be ignored`);
  }

  sendState();
}

function getNextFileName() {
  const pendingFiles = getPendingFiles();
  return pendingFiles.length ? pendingFiles[0] : null;
}

async function processOneFile() {
  if (!working || childFfmpeg) {
    return 'busy';
  }

  const input = getNextFileName();
  if (!input) {
    return 'empty';
  }

  const tmpName = getTempName(input);
  const displayName = getDisplayName(input);
  currentFile = input;
  removeFileIfExists(tmpName);
  sendState();
  log(`Processing ${runStats.completed + 1}/${runStats.total}: ${displayName}`);

  return new Promise((resolve) => {
    let settled = false;

    const settle = (result) => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(result);
    };

    try {
      childFfmpeg = spawn(
        getFfmpegPath(),
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          input,
          '-vcodec',
          'libx264',
          '-preset',
          activeOptions.preset,
          '-crf',
          String(activeOptions.crf),
          '-map_metadata',
          '0',
          '-acodec',
          'aac',
          '-y',
          tmpName,
        ],
        { windowsHide: true },
      );
    } catch (err) {
      failedFiles.add(input);
      runStats.completed += 1;
      runStats.failed += 1;
      currentFile = null;
      removeFileIfExists(tmpName);
      log(`Could not start ffmpeg: ${err.message}`);
      sendState();
      settle('fatal');
      return;
    }

    if (childFfmpeg.pid) {
      try {
        os.setPriority(childFfmpeg.pid, os.constants.priority.PRIORITY_LOW);
      } catch (err) {
        log(`Could not lower ffmpeg priority: ${err.message}`);
      }
    }

    childFfmpeg.stderr.on('data', (data) => {
      const text = data.toString().trim();
      if (text) {
        log(text);
      }
    });

    childFfmpeg.on('error', (err) => {
      childFfmpeg = null;
      failedFiles.add(input);
      runStats.completed += 1;
      runStats.failed += 1;
      currentFile = null;
      removeFileIfExists(tmpName);
      log(`ffmpeg failed to start: ${err.message}`);
      sendState();
      settle('fatal');
    });

    childFfmpeg.on('exit', async (code, signal) => {
      if (settled) {
        return;
      }

      const wasStopping = stopRequested || signal === 'SIGTERM' || signal === 'SIGKILL';
      childFfmpeg = null;

      if (wasStopping) {
        currentFile = null;
        removeFileIfExists(tmpName);
        log(`Stopped while processing ${displayName}`);
        sendState();
        settle('stopped');
        return;
      }

      runStats.completed += 1;

      if (code) {
        failedFiles.add(input);
        runStats.failed += 1;
        currentFile = null;
        removeFileIfExists(tmpName);
        log(`ffmpeg exited with code ${code} for ${displayName}`);
        sendState();
        settle('failed');
        return;
      }

      let inputStats;
      let outputStats;

      try {
        inputStats = statSync(input);
        outputStats = statSync(tmpName);
      } catch (err) {
        failedFiles.add(input);
        runStats.failed += 1;
        currentFile = null;
        removeFileIfExists(tmpName);
        log(`Could not inspect processed output for ${displayName}: ${err.message}`);
        sendState();
        settle('failed');
        return;
      }

      const savedMb = (inputStats.size - outputStats.size) / (1024 * 1024);
      const savedPercent = inputStats.size
        ? Math.round(((inputStats.size - outputStats.size) / inputStats.size) * 100)
        : 0;

      if (savedMb <= 0) {
        addProcessedFile(input);
        runStats.skippedLarger += 1;
        currentFile = null;
        removeFileIfExists(tmpName);
        log(`Output was not smaller for ${displayName}; kept the original file`);
        sendState();
        settle('skipped');
        return;
      }

      try {
        renameSync(tmpName, input);
      } catch (err) {
        failedFiles.add(input);
        runStats.failed += 1;
        currentFile = null;
        removeFileIfExists(tmpName);
        log(`Could not replace ${displayName}: ${err.message}`);
        sendState();
        settle('failed');
        return;
      }

      addProcessedFile(input);
      runStats.compressed += 1;
      spaceSavedMb += savedMb;

      try {
        await utimes(input, {
          btime: inputStats.birthtime.getTime(),
          atime: inputStats.atime.getTime(),
          mtime: inputStats.mtime.getTime(),
        });
      } catch (err) {
        log(`Could not restore timestamps for ${displayName}: ${err.message}`);
      }

      currentFile = null;
      log(`Saved ${roundNumber(savedMb)} MB (${savedPercent}%) from ${displayName}`);
      sendState();
      settle('processed');
    });
  });
}

async function start(options = {}) {
  if (!dir) {
    log('Select a folder before starting');
    sendState();
    return { ok: false, reason: 'no-folder' };
  }

  if (working) {
    log('Processing is already running');
    sendState();
    return { ok: false, reason: 'running' };
  }

  activeOptions = normalizeOptions(options);
  failedFiles = new Set();
  spaceSavedMb = 0;
  currentFile = null;
  stopRequested = false;
  runStats = createRunStats(getPendingFiles().length);

  if (runStats.total === 0) {
    appStatus = 'done';
    log('No new videos to process');
    sendState();
    return { ok: true };
  }

  working = true;
  appStatus = 'running';
  log(
    `Starting ${runStats.total} videos with CRF ${activeOptions.crf} and ${activeOptions.preset} preset`,
  );
  sendState();

  while (working && !stopRequested) {
    const result = await processOneFile();

    if (result === 'empty') {
      break;
    }

    if (result === 'stopped') {
      break;
    }

    if (result === 'busy') {
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }

    if (result === 'fatal') {
      appStatus = 'error';
      break;
    }
  }

  const wasStopped = stopRequested;
  working = false;
  stopRequested = false;
  currentFile = null;

  if (wasStopped) {
    appStatus = 'ready';
    log(
      `Stopped. Completed ${runStats.completed}/${runStats.total}; saved ${roundNumber(spaceSavedMb)} MB`,
    );
  } else if (appStatus === 'error') {
    log(`Stopped after an ffmpeg startup error; saved ${roundNumber(spaceSavedMb)} MB`);
  } else {
    appStatus = 'done';
    log(
      `Done. Compressed ${runStats.compressed}, skipped ${runStats.skippedLarger}, failed ${runStats.failed}. Saved ${roundNumber(spaceSavedMb)} MB total`,
    );
  }

  sendState();
  return { ok: true };
}

function stop() {
  if (!working) {
    sendState();
    return { ok: true };
  }

  stopRequested = true;
  appStatus = 'stopping';
  log('Stopping after the current ffmpeg process exits');
  sendState();

  if (childFfmpeg) {
    childFfmpeg.kill();
  }

  return { ok: true };
}

ipcMain.handle('proc-pick-dir', async () => {
  if (working) {
    log('Stop processing before choosing another folder');
    return { ok: false, reason: 'running', state: getState() };
  }

  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
  });

  if (result.canceled || !result.filePaths.length) {
    log('No folder selected');
    return { ok: false, reason: 'cancelled', state: getState() };
  }

  dir = result.filePaths[0];
  files = [];
  failedFiles = new Set();
  runStats = createRunStats();
  currentFile = null;
  spaceSavedMb = 0;
  appStatus = 'scanning';
  log(`Scanning ${dir}`);
  sendState();

  try {
    await scanFiles();
    appStatus = 'ready';
    sendState();
    return { ok: true, state: getState() };
  } catch (err) {
    appStatus = 'error';
    log(`Could not scan folder: ${err.message}`);
    sendState();
    return { ok: false, reason: 'scan-failed', state: getState() };
  }
});

ipcMain.handle('proc-start', (event, options) => {
  start(options).catch((err) => {
    working = false;
    stopRequested = false;
    childFfmpeg = null;
    currentFile = null;
    appStatus = 'error';
    log(`Unexpected processing error: ${err.message}`);
    sendState();
  });

  return { ok: true, state: getState() };
});

ipcMain.handle('proc-stop', () => stop());

ipcMain.handle('proc-clear-history', () => {
  if (working) {
    log('Stop processing before clearing processed history');
    return { ok: false, reason: 'running', state: getState() };
  }

  processedFiles = new Set();
  oneWayHashCache = new Map();
  saveProcessedFiles();
  appStatus = dir ? 'ready' : 'idle';
  log('Processed history cleared');
  sendState();
  return { ok: true, state: getState() };
});

ipcMain.handle('proc-get-state', () => getState());
