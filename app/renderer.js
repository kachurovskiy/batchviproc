const folderButton = document.getElementById('folderButton');
const logArea = document.getElementById('logArea');
const logContainer = document.getElementById('logContainer');

logContainer.style.display = 'none';

folderButton.addEventListener('click', () => {
  window.api.ipcRendererSend('proc-pick-dir', {});
});

window.api.ipcRendererOn('proc-dir-change', (event, message) => {
  folderButton.innerText = message.dir + ' (' + message.fileCount + ' videos)';
  logArea.value = '';
  logContainer.style.display = 'block';
});

window.api.ipcRendererOn('proc-log', (event, message) => {
  log(message);
});

function log(message) {
  logArea.value += message + '\n';
  logArea.scrollTop = logArea.scrollHeight;
}
