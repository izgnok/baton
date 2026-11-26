import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MSG } from '@rooms/shared/protocol.js';
import { fixPath } from './env.js';
import { loadConfig, saveConfig, setRepoPath } from './localConfig.js';
import { createServerClient, login, signup } from './serverClient.js';
import { claudeAuthStatus, claudeLogin } from './claudeAuth.js';
import { cloneRepo as gitClone, preflight } from './runner/preflight.js';
import { runTurn } from './runner/turn.js';
import { startCapture } from './capture.js';

const here = path.dirname(fileURLToPath(import.meta.url));

let config;
let client = null;
let win = null;
const roomCache = new Map(); // roomId → 방 상태
const pending = new Map(); // 승인 id → {resolve, requestId}
const runs = new Map(); // requestId → AbortController

const toRenderer = (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

function req(type, payload) {
  if (!client) return Promise.reject(new Error('NOT_LOGGED_IN'));
  return client.request(type, payload);
}

// 권한 승인 질문을 화면에 띄우고 답을 기다린다
function askUser({ toolName, input, toolUseId }, { requestId, roomId }) {
  const id = randomUUID();
  return new Promise((resolve) => {
    pending.set(id, { resolve, requestId });
    toRenderer('approval:ask', { id, requestId, roomId, toolName, input, toolUseId });
  });
}

function closeApproval(requestId) {
  for (const [id, p] of pending) {
    if (p.requestId !== requestId) continue;
    pending.delete(id);
    p.resolve('deny');
    toRenderer('approval:close', { requestId });
  }
}

async function handleRunStart(runStart) {
  const { requestId, roomId } = runStart;
  let state = roomCache.get(roomId);
  if (!state) {
    try {
      state = (await req(MSG.ROOM_OPEN, { roomId })).state;
      roomCache.set(roomId, state);
    } catch (e) {
      return void client?.request(MSG.RUN_FAIL, { requestId, reason: e.message }).catch(() => {});
    }
  }
  const ac = new AbortController();
  runs.set(requestId, ac);
  try {
    await runTurn({
      runStart,
      roomState: state,
      roomRepoPaths: config.rooms[roomId]?.repos ?? {},
      client,
      http: client.http,
      askUser: (q) => askUser(q, { requestId, roomId }),
      closeApproval,
      signal: ac.signal,
    });
  } finally {
    runs.delete(requestId);
  }
}

function connectClient() {
  client?.close();
  client = null;
  if (!config.serverUrl || !config.token) return;
  const c = createServerClient({ serverUrl: config.serverUrl, token: config.token });
  client = c;
  c.on('status', (s) => toRenderer('conn:status', s));
  c.on('*', (m) => {
    if (m.type === MSG.ROOM_STATE) roomCache.set(m.state.room.id, m.state);
    else if (m.type === MSG.ROOM_DELETE) roomCache.delete(m.roomId);
    if (m.type === MSG.RUN_START) return void handleRunStart(m.runStart);
    toRenderer('rooms:event', m);
  });
}

async function checkRepos({ roomId }) {
  let state = roomCache.get(roomId);
  if (!state) {
    state = (await req(MSG.ROOM_OPEN, { roomId })).state;
    roomCache.set(roomId, state);
  }
  return preflight(state.repos, config.rooms[roomId]?.repos ?? {});
}

async function linkRepo({ roomId, repoId, localPath }) {
  config = setRepoPath(config, roomId, repoId, localPath);
  saveConfig(config);
  return checkRepos({ roomId });
}

async function authenticate(fn, { serverUrl, ...body }) {
  const { token, user } = await fn(serverUrl, body);
  config = { ...config, serverUrl, token, user };
  saveConfig(config);
  connectClient();
  return user;
}

const handlers = {
  getConfig: () => ({ serverUrl: config.serverUrl, loggedIn: !!config.token, user: config.user ?? null }),
  signup: (a) => authenticate(signup, a),
  login: (a) => authenticate(login, a),
  logout: () => {
    const { user, token, ...rest } = config;
    config = { ...rest, token: null };
    saveConfig(config);
    client?.close();
    client = null;
    roomCache.clear();
  },
  claudeStatus: () => claudeAuthStatus(),
  claudeLogin: () => claudeLogin(),
  listRooms: () => req(MSG.ROOM_LIST),
  createRoom: (a) => req(MSG.ROOM_CREATE, a),
  joinRoom: (a) => req(MSG.ROOM_JOIN, a),
  leaveRoom: (a) => req(MSG.ROOM_LEAVE, a),
  openRoom: async (a) => {
    const data = await req(MSG.ROOM_OPEN, a);
    roomCache.set(a.roomId, data.state);
    return data;
  },
  renameRoom: (a) => req(MSG.ROOM_RENAME, a),
  regenerateInvite: (a) => req(MSG.INVITE_REGENERATE, a),
  deleteRoom: (a) => req(MSG.ROOM_DELETE, a),
  sendMessage: (a) => req(MSG.CHAT_SEND, a),
  retry: (a) => req(MSG.REQUEST_RETRY, a),
  addRepo: (a) => req(MSG.REPO_ADD, a),
  updateRepo: (a) => req(MSG.REPO_UPDATE, a),
  removeRepo: (a) => req(MSG.REPO_REMOVE, a),
  checkRepos,
  linkRepo,
  cloneRepo: async ({ roomId, repoId }) => {
    await checkRepos({ roomId }); // 캐시 채우기
    const repo = roomCache.get(roomId).repos.find((r) => r.id === repoId);
    if (!repo) throw new Error('NOT_FOUND');
    const localPath = await gitClone({ remoteUrl: repo.remoteUrl, branch: repo.branch, name: repo.name });
    return linkRepo({ roomId, repoId, localPath });
  },
  pickFolder: async () => {
    const r = await dialog.showOpenDialog(win ?? undefined, { properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  },
  listShared: ({ roomId }) => {
    if (!client) throw new Error('NOT_LOGGED_IN');
    return client.http.getManifest(roomId);
  },
  readShared: async ({ roomId, path: p }) => {
    if (!client) throw new Error('NOT_LOGGED_IN');
    return { base64: (await client.http.getShared(roomId, p)).toString('base64') };
  },
  answerApproval: ({ id, decision }) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    p.resolve(decision === 'allow' ? 'allow' : 'deny');
  },
};

// 자체 점검: 창 없이 서버·클라이언트·승인 MCP 가 Electron 안에서 도는지 확인한다(claude 실행은 안 한다)
async function smoke() {
  const out = {};
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-smoke-'));
  let server;
  let smokeClient;
  let bridge;
  const step = async (name, fn) => {
    try { out[name] = { ok: true, ...(await fn()) }; } catch (e) { out[name] = { ok: false, error: e.message }; }
  };
  try {
    await step('server', async () => {
      const { startServer } = await import('../../server/src/index.js');
      server = await startServer({ port: 0, dataDir: path.join(tmp, 'data') });
      return { port: server.port };
    });
    const url = `http://localhost:${server?.port}`;
    let session;
    await step('signup', async () => {
      session = await signup(url, { email: 'smoke@x.com', password: 'password1', name: 'smoke' });
      return {};
    });
    await step('connect', async () => {
      smokeClient = createServerClient({ serverUrl: url, token: session.token });
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('TIMEOUT')), 5000);
        smokeClient.on('status', (s) => { if (s.connected) { clearTimeout(t); resolve(); } });
        if (smokeClient.connected) { clearTimeout(t); resolve(); }
      });
      return {};
    });
    await step('roomCreate', async () => ({ roomId: (await smokeClient.request(MSG.ROOM_CREATE, { name: '점검' })).id }));
    await step('claudeAuth', async () => {
      const s = await claudeAuthStatus();
      return { loggedIn: s.loggedIn, subscriptionType: s.subscriptionType ?? null, error: s.error };
    });
    await step('approveMcp', async () => {
      const { startApprovalBridge } = await import('./runner/approve.js');
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
      bridge = await startApprovalBridge({ askUser: async () => 'allow' });
      const { command, args, env } = JSON.parse(fs.readFileSync(bridge.mcpConfigPath, 'utf8')).mcpServers.rooms;
      const mcp = new Client({ name: 'smoke', version: '0' });
      await mcp.connect(new StdioClientTransport({ command, args, env: { ...process.env, ...env } }));
      try {
        const tools = (await mcp.listTools()).tools.map((t) => t.name);
        const call = JSON.parse((await mcp.callTool({ name: 'approve', arguments: { tool_name: 'Bash', input: { a: 1 } } })).content[0].text);
        return { hasApprove: tools.includes('approve'), allowWorks: call.behavior === 'allow' };
      } finally { await mcp.close(); }
    });
  } finally {
    smokeClient?.close();
    await bridge?.close().catch(() => {});
    await server?.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  out.electron = process.versions.electron ?? null;
  // claude 로그인 안 돼 있어도 점검 자체는 성공으로 본다(로그인 여부는 값으로 보고)
  const required = ['server', 'signup', 'connect', 'roomCreate', 'approveMcp'];
  const ok = required.every((k) => out[k]?.ok) && out.approveMcp?.hasApprove && out.approveMcp?.allowWorks;
  out.ok = !!ok;
  return out;
}

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
  // 링크는 앱 안에서 열지 않는다. http(s) 만 기본 브라우저로 보낸다
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(here, '..', 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
}

app.on('before-quit', () => {
  for (const ac of runs.values()) ac.abort();
});
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
  config = loadConfig();
  // 화면에서 온 id 는 숫자로 맞춘다(캐시·레포 비교가 숫자 기준)
  const ids = (a) => {
    const out = { ...a };
    for (const k of ['roomId', 'repoId', 'requestId']) if (out[k] != null) out[k] = Number(out[k]);
    return out;
  };
  for (const [name, fn] of Object.entries(handlers)) ipcMain.handle(name, (_e, args = {}) => fn(ids(args)));
  connectClient();
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  if (cap) {
    const timer = setTimeout(() => { console.error('CAPTURE_TIMEOUT'); app.exit(1); }, 120000);
    const ok = await cap.run({ handlers, getWin: () => win, toRenderer, getClient: () => client })
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
