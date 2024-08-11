const {app, BrowserWindow, dialog, ipcMain} = require('electron');
const path = require('path');
const {globSync} = require('glob');
const os = require('os');
const {renameSync, statSync, unlinkSync} = require('fs');
const {spawn} = require('child_process');
const tmp = require('tmp');
const {utimes} = require('utimes');
const ffPath = require('ffmpeg-static');

let win;
let dir;
let files = [];
let processedFiles = [];
let working = false;
let childFfmpeg;
let spaceSavedMb = 0;

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

function addNewFiles() {
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
  log(`found ${res.length} videos`);
  send('proc-dir-change', {dir, fileCount: files.length});
}

function getUnprocessedFileName() {
  for (let file of files) {
    if (processedFiles.indexOf(file) >= 0) {
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
    const input = getUnprocessedFileName();
    if (!input) {
      resolve(false);
      return;
    }
    const extension = input.split('.').pop();
    const tmpName = input.replace('.' + extension, '.tmp.' + extension);
    processedFiles.push(input);
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
        resolve(false);
      } else {
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
      addNewFiles();
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
