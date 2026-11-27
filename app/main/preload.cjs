// 렌더러에 노출하는 IPC. 메인의 오류 메시지에 붙는 Electron 접두어를 떼어 코드만 남긴다
const { contextBridge, ipcRenderer } = require('electron');

const PREFIX = /^Error invoking remote method '[^']+': (?:Error: )?/;
const call = (channel) => (args) => ipcRenderer.invoke(channel, args).catch((e) => {
  throw new Error(String(e?.message ?? e).replace(PREFIX, ''));
});

const calls = [
  'getConfig', 'signup', 'login', 'logout', 'claudeStatus', 'claudeLogin',
  'listRooms', 'createRoom', 'joinRoom', 'leaveRoom', 'openRoom', 'renameRoom', 'regenerateInvite', 'deleteRoom',
  'sendMessage', 'retry', 'addRepo', 'updateRepo', 'removeRepo',
  'checkRepos', 'linkRepo', 'cloneRepo', 'inspectRepo', 'pickFolder', 'openFolder', 'listShared', 'readShared', 'answerApproval',
  'cancelRequest', 'rescanRepos', 'listReadDirs', 'addReadDir', 'removeReadDir', 'listSkills', 'listRepoFiles',
  'setRoomModel', 'setRoomSettings', 'getUsage', 'checkUpdate', 'applyUpdate',
];

const subscribe = (channel) => (fn) => {
  const handler = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('rooms', {
  ...Object.fromEntries(calls.map((name) => [name, call(name)])),
  onEvent: subscribe('rooms:event'),
  onApproval: subscribe('approval:ask'),
  onApprovalClose: subscribe('approval:close'),
  onStatus: subscribe('conn:status'),
  onUsage: subscribe('usage'),
  onUpdate: subscribe('update'),
});
