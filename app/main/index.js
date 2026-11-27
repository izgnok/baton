import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixPath } from './env.js';
import { createService, smoke } from './service.js';
import { startCapture } from './capture.js';

const here = path.dirname(fileURLToPath(import.meta.url));

let win = null;

const toRenderer = (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

const service = createService({ emit: toRenderer, relaunch: () => { app.relaunch(); app.exit(0); } });
const { handlers } = service;

// 서비스는 열지 않고 경로만 돌려준다. 여는 일은 여기서
const nativeHandlers = {
  ...handlers,
  openFolder: async (a) => {
    const { path: p } = await handlers.openFolder(a);
    if (await shell.openPath(p)) throw new Error('NOT_FOUND');
  },
  openShared: async (a) => {
    const { path: p, reveal } = await handlers.openShared(a);
    if (reveal) return void shell.showItemInFolder(p);
    if (await shell.openPath(p)) throw new Error('NOT_FOUND');
  },
  pickFolder: async () => {
    const r = await dialog.showOpenDialog(win ?? undefined, { properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  },
};

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(here, 'preload.cjs'),
    },
  });
  win.on('focus', () => service.onFocus());
  // 링크는 앱 안에서 열지 않는다. http(s) 만 기본 브라우저로 보낸다
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(here, '..', 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
}

app.on('before-quit', () => service.stop());
app.on('window-all-closed', () => app.quit());

// 주의: ESM 메인에서 최상위 await 로 ready 를 기다리면 앱이 멈춘다
async function main() {
  await fixPath();

  if (process.env.ROOMS_SMOKE) {
    const timer = setTimeout(() => { console.log(JSON.stringify({ ok: false, error: 'SMOKE_TIMEOUT' })); app.exit(1); }, 60000);
    const result = await smoke().catch((e) => ({ ok: false, error: e.message }));
    clearTimeout(timer);
    console.log(JSON.stringify(result));
    app.exit(result.ok ? 0 : 1);
    return;
  }
  // 캡처 모드는 설정을 읽기 전에 임시 ROOMS_HOME 을 잡아야 한다
  const cap = process.env.ROOMS_SCREENSHOT ? await startCapture(process.env.ROOMS_SCREENSHOT) : null;
  for (const [name, fn] of Object.entries(nativeHandlers)) ipcMain.handle(name, (_e, args = {}) => fn(args));
  await service.start({ capture: !!cap });
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  if (cap) {
    const timer = setTimeout(() => { console.error('CAPTURE_TIMEOUT'); app.exit(1); }, 120000);
    const ok = await cap.run({ handlers, getWin: () => win, toRenderer, getClient: service.getClient })
      .then(() => true, (e) => { console.error(e); return false; });
    clearTimeout(timer);
    await cap.cleanup();
    app.exit(ok ? 0 : 1);
  }
}

app.whenReady().then(main).catch((e) => {
  console.error(e);
  app.exit(1);
});
