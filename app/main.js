const {app, BrowserWindow, dialog, ipcMain} = require('electron');
const fs = require('fs');
const path = require('path');
const {globSync} = require('glob');
const os = require('os');
const {renameSync, statSync, unlinkSync} = require('fs');
const {spawn} = require('child_process');
const tmp = require('tmp');
const {utimes} = require('utimes');
const ffPath = require('ffmpeg-static');
const crypto = require('crypto');

let win;
let dir;
let files = [];
let processedFiles = [];
let failedFiles = [];
let oneWayHashCache = {};
let working = false;
let childFfmpeg;
let spaceSavedMb = 0;

const userDataPath = app.getPath('userData');
const processedFilesPath = path.join(userDataPath, 'processedFiles.txt');

if (fs.existsSync(processedFilesPath)) {
  try {
    const data = fs.readFileSync(processedFilesPath, 'utf8');
    processedFiles = data.split('\n').map(line => line.trim()).filter(line => !!line);
  } catch (err) {
    console.error('Error reading processed files', err);
  }
}

async function sortFilesBySizeDesc(filePaths) {
  return filePaths.map((filePath) => {
    try {
      const stats = fs.statSync(filePath);
      return { filePath, size: stats.size };
    } catch (e) {
      console.error('Error statting file', e);
      return null;
    }
  }).filter((x) => x !== null).sort((a, b) => b.size - a.size).map(file => file.filePath);
}

function saveProcessedFiles() {
  try {
    fs.writeFileSync(processedFilesPath, processedFiles.join('\n'));
  } catch (err) {
    console.error('Error saving processed files', err);
  }
}

function oneWayHash(value) {
  if (oneWayHashCache[value]) return oneWayHashCache[value];
  const result = crypto.createHash('sha256').update(value).digest('hex');
  oneWayHashCache[value] = result;
  return result;
}

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 800,
    height: 800,
    webPreferences: {preload: path.join(__dirname, "preload.js")}
  });
  win.loadFile('app/index.html');
});

app.on('window-all-closed', () => {
  app.quit();
});

function send(name, message) {
  win.webContents.send(name, message);
}

function log(message) {
  send('proc-log', message);
}

async function addNewFiles() {
  const res = globSync('**/*{/,+(.mp4|.MP4|.mts|.MTS|.m2ts|.M2TS|.flv|.FLV|.m4v|.M4V)}', {cwd: dir});
  for (let i = res.length - 1; i >= 0; i--) {
    if (res[i].endsWith('/') || res[i].endsWith('\\')) {
      res.splice(i, 1);
    } else {
      const newFile = path.join(dir, res[i]);
      if (files.indexOf(newFile) == -1) {
        files.push(newFile);
      }
    }
  }
  send('proc-dir-change', {dir, fileCount: files.length});
  log(`found ${res.length} videos`);
  log(`there are ${processedFiles.length} known, already processed files in ${processedFilesPath} - if you expect needing to re-process some of the already compressed files, delete that file and restart the app`);
  files = await sortFilesBySizeDesc(files);
}

function getNextFileName() {
  for (let file of files) {
    if (processedFiles.includes(oneWayHash(file)) || failedFiles.includes(file) || file.includes('.batchviproc.') || file.includes('.tmp.') || file.includes('-h264.')) {
      continue;
    }
    return file;
  }
  return null;
}

async function processOneFile() {
  if (!working || childFfmpeg) {
    return false;
  }
  return new Promise((resolve, reject) => {
    const input = getNextFileName();
    if (!input) {
      resolve(false);
      return;
    }
    const extension = input.split('.').pop();
    const tmpName = input.replace('.' + extension, '.batchviproc.' + extension);
    log(input);
    childFfmpeg = spawn(ffPath.replace('app.asar', 'app.asar.unpacked'), [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      input,
      '-vcodec',
      'libx264',
      '-preset',
      'slow',
      '-map_metadata',
      '0',
      '-acodec',
      'aac',
      '-y', // overwrite tmp output file if exists
      tmpName
    ]);
    os.setPriority(childFfmpeg.pid, os.constants.priority.PRIORITY_LOW);
    childFfmpeg.stdout.on('data', (data) => {
      log(`stdout: ${data}`);
    });
    childFfmpeg.stderr.on('data', (data) => {
      log(`stderr: ${data}`);
    });
    childFfmpeg.on('exit', async (code) => {
      childFfmpeg = null;
      if (code) {
        log(`ffmpeg exited with ${code}`);
        failedFiles.push(input);
        resolve(false);
      } else {
        processedFiles.push(oneWayHash(input));
        saveProcessedFiles();

        const inputStats = statSync(input);
        const outputStats = statSync(tmpName);
        const savedMb = (inputStats.size - outputStats.size)  / (1024 * 1024);
        if (savedMb < 0) {
          log("Compressed file is larger");
          unlinkSync(tmpName);
          resolve(true);
          return;
        }
        spaceSavedMb += savedMb;
        log('Saved ' + Math.round(savedMb) + 'Mb');
        try {
          renameSync(tmpName, input);
        } catch (e) {
          log(`Error moving ${tmpName}: ` + e);
          resolve(false);
          return;
        }
        try {
          await utimes(input, {
            btime: inputStats.birthtime.getTime(),
            atime: inputStats.atime.getTime(),
            mtime: inputStats.mtime.getTime()
          });
        } catch (e) {
          log('Error changing file timestamps (' + inputStats + '): ' + e);
        }
        resolve(true);
      }
    });
  });
}

ipcMain.on('proc-pick-dir', async (event, arg) => {
  log('picking folder');
  const paths = dialog.showOpenDialogSync(win, {properties: ['openDirectory']});
  if (paths) {
    log('folder ' + paths);
    dir = paths[0];
    spaceSavedMb = 0;
    try {
      await addNewFiles();
      await stop();
      await start();
    } catch (err) {
      log(err);
    }
  } else {
    log('nothing selected');
  }
});

async function start() {
  if (!dir) {
    log('no folder selected');
    return;
  }
  if (working) {
    log('already running');
    return;
  }
  working = true;
  log('starting in ' + dir);
  while (true) {
    try {
      if (!await processOneFile()) {
        break;
      }
    } catch (e) {
      log('failed: ' + e);
    }
  }
  log('Done. Space saved total ' + Math.round(spaceSavedMb) + 'Mb');
  working = false;
}

function stop() {
  if (!working) {
    return;
  }
  if (childFfmpeg) {
    childFfmpeg.kill();
    childFfmpeg = null;
  }
  working = false;
}
