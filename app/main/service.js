import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MSG } from '@rooms/shared/protocol.js';
import { loadConfig, saveConfig, setRepoPath, addReadDirs, removeReadDir, setRoomModel, effectiveModel, roomsHome } from './localConfig.js';
import { mergeUsage, fetchUsage } from './usage.js';
import { createUpdater } from './updater.js';
import { scanRepos, matchRepo, detectReadDirs } from './repoIndex.js';
import { listSkills } from './skills.js';
import { createServerClient, login, signup, getServerCommit } from './serverClient.js';
import { claudeAuthStatus, claudeLogin } from './claudeAuth.js';
import { cloneRepo as gitClone, inspectRepo, preflight } from './runner/preflight.js';
import { runTurn } from './runner/turn.js';
import { roomDirOf } from './runner/sync.js';
import { createSharedSync } from './sharedSync.js';
import { safeJoin } from '@rooms/shared/paths.js';
import { worktreePath, isProtectedBranch, removeWorktree, listRepoFiles } from './runner/worktree.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Electron 과 무관한 앱 로직. 화면 알림은 emit, 업데이트 후 다시 켜기는 relaunch 로 밖에 맡긴다
 * @param {{emit: (event: string, payload: any) => void, relaunch: () => void}} p
 */
export function createService({ emit, relaunch }) {
  let config;
  let client = null;
  let updater = null;
  const roomCache = new Map(); // roomId → 방 상태
  const pending = new Map(); // 승인 id → {resolve, requestId}
  const runs = new Map(); // requestId → AbortController
  const runningRooms = new Map(); // roomId → 이 PC 에서 실행 중인 요청 수

  const toRenderer = (channel, payload) => emit(channel, payload);

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
    const ac = new AbortController(); // 방을 여는 동안 중단 신호가 와도 놓치지 않게 먼저 만든다
    runs.set(requestId, ac);
    runningRooms.set(roomId, (runningRooms.get(roomId) ?? 0) + 1);
    try {
      let state = roomCache.get(roomId);
      if (!state) {
        try {
          state = (await req(MSG.ROOM_OPEN, { roomId })).state;
          roomCache.set(roomId, state);
        } catch (e) {
          return void client?.request(MSG.RUN_FAIL, { requestId, reason: e.message }).catch(() => {});
        }
      }
      // 실행이 공유 폴더를 서버 내용으로 덮기 전에, 직접 고친 파일부터 올린다
      await sharedSync.pushLocal(roomId).catch((e) => console.error('공유 파일 올리기 실패', e));
      await runTurn({
        runStart,
        roomState: state,
        roomRepoPaths: config.rooms[roomId]?.repos ?? {},
        client,
        http: client.http,
        askUser: (q) => askUser(q, { requestId, roomId }),
        closeApproval,
        readDirs: config.rooms[roomId]?.readDirs ?? [],
        repoIndex: config.repoIndex?.repos ?? [],
        ...effectiveModel(config, roomId, state.room), // 개인 선택 → 방 기본 → 내 Claude 설정
        onRateLimit: (ev) => {
          const usage = mergeUsage(config.usage, ev, Date.now());
          if (!usage) return;
          config = { ...config, usage };
          saveConfig(config);
          toRenderer('usage', usage);
        },
        signal: ac.signal,
      });
    } finally {
      runs.delete(requestId);
      const n = (runningRooms.get(roomId) ?? 1) - 1;
      if (n > 0) runningRooms.set(roomId, n); else runningRooms.delete(roomId);
      if (!n) syncShared(roomId).catch(() => {}); // 실행이 올린 결과로 기준(스냅샷)을 다시 맞춘다
    }
  }

  function connectClient() {
    client?.close();
    client = null;
    if (!config.serverUrl || !config.token) return;
    const c = createServerClient({ serverUrl: config.serverUrl, token: config.token });
    client = c;
    c.on('status', (s) => {
      toRenderer('conn:status', s);
      if (s.connected) getServerCommit(config.serverUrl).then((commit) => updater?.setServerCommit(commit)).catch(() => {});
    });
    c.on('*', (m) => {
      if (m.type === MSG.ROOM_STATE) {
        const roomId = m.state.room.id;
        const names = (s) => JSON.stringify(s?.repos.map((r) => [r.id, r.name]));
        const renamed = names(roomCache.get(roomId)) !== names(m.state);
        roomCache.set(roomId, m.state);
        const linked = autoLink(roomId, m.state);
        if (linked) toRenderer('rooms:event', { type: 'local.repos', roomId });
        if (linked || renamed) sendMemberStatus(roomId);
        rescanIfMissing();
      } else if (m.type === MSG.ROOM_DELETE) roomCache.delete(m.roomId);
      // 다른 사람이 공유 파일을 바꿨으면 이 PC 에 받아 둔 방만 다시 맞춘다
      else if (m.type === MSG.SHARED_CHANGED && fs.existsSync(roomDirOf(m.roomId))) {
        syncShared(m.roomId).catch((e) => console.error('공유 파일 받기 실패', e));
      }
      if (m.type === MSG.RUN_START) return void handleRunStart(m.runStart);
      if (m.type === MSG.RUN_CANCEL) return void runs.get(Number(m.requestId))?.abort();
      toRenderer('rooms:event', m);
    });
  }

  // 레포를 연결하고, 그 위쪽의 CLAUDE.md·.claude 폴더를 함께 읽는 폴더에 넣는다
  function linkLocal(roomId, repoId, localPath) {
    config = addReadDirs(setRepoPath(config, roomId, repoId, localPath), roomId, detectReadDirs(localPath, os.homedir()));
    saveConfig(config);
  }

  // 연결 안 된 방 레포 중 내 PC 레포 목록에 같은 원격 주소가 있는 것을 자동 연결한다. 바뀌었으면 true
  function autoLink(roomId, state) {
    let changed = false;
    for (const repo of state.repos) {
      if (config.rooms[roomId]?.repos?.[repo.id]) continue;
      const found = matchRepo(config.repoIndex, repo.remoteUrl);
      if (!found) continue;
      linkLocal(roomId, repo.id, found);
      changed = true;
    }
    return changed;
  }

  let claudeCache = { at: 0, ok: false };
  async function claudeLoggedIn() {
    if (Date.now() - claudeCache.at > 60000) claudeCache = { at: Date.now(), ok: !!(await claudeAuthStatus().catch(() => null))?.loggedIn };
    return claudeCache.ok;
  }

  // 내 연결 요약(레포 이름·함께 읽는 폴더 마지막 이름·Claude 로그인)을 서버에 알린다. 전체 경로는 보내지 않는다
  async function sendMemberStatus(roomId) {
    const state = roomCache.get(roomId);
    if (!state || !client) return;
    const room = config.rooms[roomId] ?? {};
    const status = {
      repos: state.repos.filter((r) => room.repos?.[r.id]).map((r) => r.name),
      readDirs: (room.readDirs ?? []).map((d) => path.basename(d)),
      claude: await claudeLoggedIn(),
    };
    client.request(MSG.MEMBER_STATUS, { roomId, status }).catch(() => {});
  }

  let scanning = null;
  function rescan() {
    scanning ??= (async () => {
      const repos = await scanRepos({});
      config = { ...config, repoIndex: { scannedAt: Date.now(), repos } };
      saveConfig(config);
      for (const [roomId, state] of roomCache) {
        if (autoLink(roomId, state)) toRenderer('rooms:event', { type: 'local.repos', roomId });
        sendMemberStatus(roomId);
      }
      return config.repoIndex;
    })().finally(() => { scanning = null; });
    return scanning;
  }

  // 방 공유 파일을 내 PC 폴더(~/.claude-rooms/<방>/shared)에 받아 둔다.
  // 이 PC 에서 그 방의 Claude 가 실행 중이면 작업 중인 파일을 덮어쓰지 않게 건너뛴다
  const sharedSync = createSharedSync({
    getClient: () => client,
    roomDirOf,
    isRunning: (roomId) => runningRooms.has(roomId),
    onConflict: (roomId, paths) => toRenderer('rooms:event', { type: 'local.sharedConflict', roomId, paths }),
  });
  const syncShared = (roomId) => sharedSync.sync(Number(roomId));

  // 사용량: 실행 때 오는 값 외에도 `claude -p /usage`(모델 호출 없음)로 5분마다·창으로 돌아올 때(1분에 한 번까지) 읽는다
  let usageAt = 0;
  async function refreshUsage() {
    if (process.env.ROOMS_SCREENSHOT || process.env.ROOMS_NO_BACKGROUND || Date.now() - usageAt < 60000) return;
    usageAt = Date.now();
    const found = await fetchUsage().catch(() => undefined);
    if (!found) return;
    config = { ...config, usage: { ...config.usage, ...found, updatedAt: Date.now() } };
    saveConfig(config);
    toRenderer('usage', config.usage);
  }
  const sharedDirOf = (roomId) => path.join(roomDirOf(Number(roomId)), 'shared');

  // 연결 안 된 방 레포가 있으면 홈 아래를 다시 찾는다(앱을 켠 뒤 clone 하거나 옮긴 레포). 1분에 한 번까지
  function rescanIfMissing() {
    if (process.env.ROOMS_SCREENSHOT || process.env.ROOMS_NO_BACKGROUND || scanning || Date.now() - (config.repoIndex?.scannedAt ?? 0) < 60000) return;
    const missing = [...roomCache].some(([roomId, st]) => st.repos.some((r) => !config.rooms[roomId]?.repos?.[r.id]));
    if (missing) rescan().catch((e) => console.error('레포 찾기 실패', e));
  }

  async function checkRepos({ roomId }) {
    let state = roomCache.get(roomId);
    if (!state) {
      state = (await req(MSG.ROOM_OPEN, { roomId })).state;
      roomCache.set(roomId, state);
    }
    const res = await preflight(state.repos, config.rooms[roomId]?.repos ?? {});
    const indexed = new Set((config.repoIndex?.repos ?? []).map((r) => r.path));
    res.results = res.results.map((r) => {
      const repo = state.repos.find((x) => x.id === r.repoId);
      const wt = worktreePath(roomId, repo);
      // indexed: 내 PC 레포 목록에 있는 경로(자동 연결 대상)
      return { ...r, worktreePath: wt, worktreeExists: fs.existsSync(wt), protected: isProtectedBranch(repo.branch), indexed: !!r.localPath && indexed.has(r.localPath) };
    });
    return res;
  }

  const stateOf = async (roomId) => roomCache.get(roomId) ?? (await req(MSG.ROOM_OPEN, { roomId })).state;

  // 방 레포들의 작업 폴더를 지운다. 안 올린 변경이 있어 남긴 것만 목록으로 돌려준다
  async function cleanWorktrees(roomId, repos) {
    const kept = [];
    for (const repo of repos) {
      const wt = worktreePath(roomId, repo);
      const sourcePath = config.rooms[roomId]?.repos?.[repo.id];
      try {
        if (!sourcePath && fs.existsSync(wt)) throw new Error('NO_SOURCE');
        const r = await removeWorktree({ sourcePath, worktreePath: wt, branch: repo.branch });
        if (!r.removed) kept.push({ repoId: repo.id, name: repo.name, path: wt, reason: r.reason });
      } catch (e) {
        kept.push({ repoId: repo.id, name: repo.name, path: wt, reason: e.message === 'NO_SOURCE' ? e.message : 'FAILED' });
      }
    }
    return kept;
  }

  // 폴더 열기는 방 작업 폴더나 내가 연결한 원본 폴더만 허용한다
  function openableDir(p) {
    if (typeof p !== 'string' || !path.isAbsolute(p)) return false;
    const target = path.resolve(p);
    const inside = (base) => { const rel = path.relative(path.resolve(base), target); return !rel.startsWith('..') && !path.isAbsolute(rel); };
    const linked = Object.values(config.rooms).flatMap((r) => Object.values(r.repos ?? {})).map((x) => path.resolve(x));
    if (!inside(roomsHome()) && !linked.includes(target)) return false;
    try { return fs.statSync(target).isDirectory(); } catch { return false; }
  }

  async function linkRepo({ roomId, repoId, localPath }) {
    linkLocal(roomId, repoId, localPath);
    sendMemberStatus(roomId);
    return checkRepos({ roomId });
  }

  const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

  // 방 작업 폴더가 있으면 그 폴더, 없으면 빈 목록(프로젝트 스킬은 작업 폴더 기준)
  function roomWorkDirs(roomId) {
    const state = roomCache.get(roomId);
    return (state?.repos ?? []).map((r) => worktreePath(roomId, r)).filter(isDir);
  }

  async function authenticate(fn, { serverUrl, ...body }) {
    const { token, user } = await fn(serverUrl, body);
    config = { ...config, serverUrl, token, user };
    saveConfig(config);
    connectClient();
    return user;
  }

  const handlers = {
    getConfig: () => ({ serverUrl: config.serverUrl, loggedIn: !!config.token, user: config.user ?? null, hostServer: !!config.hostServer }),
    setHostServer: ({ on }) => {
      config = { ...config, hostServer: !!on };
      saveConfig(config);
      return { hostServer: config.hostServer };
    },
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
    claudeLogin: async () => {
      await claudeLogin();
      claudeCache.at = 0;
      for (const roomId of roomCache.keys()) sendMemberStatus(roomId);
    },
    listRooms: () => req(MSG.ROOM_LIST),
    createRoom: (a) => req(MSG.ROOM_CREATE, a),
    joinRoom: (a) => req(MSG.ROOM_JOIN, a),
    leaveRoom: async (a) => {
      const repos = (await stateOf(a.roomId).catch(() => null))?.repos ?? [];
      await req(MSG.ROOM_LEAVE, a);
      return { keptWorktrees: await cleanWorktrees(a.roomId, repos) };
    },
    openRoom: async (a) => {
      const data = await req(MSG.ROOM_OPEN, a);
      roomCache.set(a.roomId, data.state);
      autoLink(a.roomId, data.state);
      sendMemberStatus(a.roomId);
      rescanIfMissing();
      syncShared(a.roomId).catch((e) => console.error('공유 파일 받기 실패', e));
      const mine = config.rooms[a.roomId] ?? {};
      return { ...data, myModel: { model: mine.model ?? '', effort: mine.effort ?? '' } };
    },
    setRoomModel: ({ roomId, model, effort }) => {
      config = setRoomModel(config, roomId, model, effort);
      saveConfig(config);
    },
    setRoomSettings: (a) => req(MSG.ROOM_SETTINGS, a),
    getUsage: () => config.usage ?? null,
    checkUpdate: () => updater.check(),
    applyUpdate: () => updater.apply(),
    renameRoom: (a) => req(MSG.ROOM_RENAME, a),
    regenerateInvite: (a) => req(MSG.INVITE_REGENERATE, a),
    deleteRoom: async (a) => {
      const repos = (await stateOf(a.roomId).catch(() => null))?.repos ?? [];
      await req(MSG.ROOM_DELETE, a);
      return { keptWorktrees: await cleanWorktrees(a.roomId, repos) };
    },
    sendMessage: (a) => req(MSG.CHAT_SEND, a),
    retry: (a) => req(MSG.REQUEST_RETRY, a),
    cancelRequest: (a) => req(MSG.REQUEST_CANCEL, a),
    addRepo: (a) => req(MSG.REPO_ADD, a),
    updateRepo: (a) => req(MSG.REPO_UPDATE, a),
    removeRepo: async (a) => {
      // 서버에서 지워지면(방장만 가능) 그 레포의 내 작업 폴더도 정리한다
      const hit = [...roomCache.entries()].find(([, s]) => s.repos.some((r) => r.id === a.repoId));
      await req(MSG.REPO_REMOVE, a);
      if (!hit) return {};
      const [roomId, state] = hit;
      const [kept] = await cleanWorktrees(roomId, state.repos.filter((r) => r.id === a.repoId));
      return kept ? { keptWorktree: kept.path, reason: kept.reason } : {};
    },
    checkRepos,
    linkRepo,
    cloneRepo: async ({ roomId, repoId }) => {
      await checkRepos({ roomId }); // 캐시 채우기
      const repo = roomCache.get(roomId).repos.find((r) => r.id === repoId);
      if (!repo) throw new Error('NOT_FOUND');
      const localPath = await gitClone({ remoteUrl: repo.remoteUrl, branch: repo.branch, name: repo.name });
      return linkRepo({ roomId, repoId, localPath });
    },
    inspectRepo: ({ localPath }) => inspectRepo(localPath),
    listReadDirs: ({ roomId }) => config.rooms[roomId]?.readDirs ?? [],
    addReadDir: ({ roomId, path: p }) => {
      if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error('INVALID_INPUT');
      if (!isDir(p)) throw new Error('NOT_FOUND');
      config = addReadDirs(config, roomId, [path.resolve(p)]);
      saveConfig(config);
      sendMemberStatus(roomId);
      return config.rooms[roomId].readDirs;
    },
    removeReadDir: ({ roomId, path: p }) => {
      config = removeReadDir(config, roomId, p);
      saveConfig(config);
      sendMemberStatus(roomId);
      return config.rooms[roomId]?.readDirs ?? [];
    },
    listSkills: ({ roomId } = {}) => listSkills({ workDirs: roomId != null ? roomWorkDirs(roomId) : [] }),
    listRepoFiles: async ({ roomId, query }) => listRepoFiles({ roomId, repos: (await stateOf(roomId)).repos, query }),
    // 열지 않고 열 경로만 돌려준다(여는 일은 앱 쪽)
    openFolder: async ({ path: p }) => {
      if (!openableDir(p)) throw new Error('FORBIDDEN');
      return { path: path.resolve(p) };
    },
    listShared: async ({ roomId }) => {
      if (!client) throw new Error('NOT_LOGGED_IN');
      await syncShared(roomId).catch((e) => console.error('공유 파일 받기 실패', e));
      return client.http.getManifest(roomId);
    },
    // 공유 파일의 경로와 reveal(Finder 에서 보여 주기) 여부를 돌려준다. path 가 없으면 공유 폴더. 여는 일은 앱 쪽
    openShared: async ({ roomId, path: p, reveal = false }) => {
      const dir = sharedDirOf(roomId);
      let target = dir;
      if (p != null) {
        try { target = safeJoin(dir, p); } catch { throw new Error('FORBIDDEN'); }
        if (!fs.existsSync(target)) await syncShared(Number(roomId)).catch(() => {});
      } else fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(target)) throw new Error('NOT_FOUND');
      return { path: target, reveal: !!reveal };
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

  // 화면에서 온 id 는 숫자로 맞춘다(캐시·레포 비교가 숫자 기준)
  const ids = (a) => {
    const out = { ...a };
    for (const k of ['roomId', 'repoId', 'requestId']) if (out[k] != null) out[k] = Number(out[k]);
    return out;
  };
  const wrapped = Object.fromEntries(Object.entries(handlers).map(([name, fn]) => [name, (a = {}) => fn(ids(a))]));

  // 캡처 모드는 설정을 읽기 전에 임시 ROOMS_HOME 을 잡아 둬야 한다(호출 쪽 몫)
  async function start({ capture = false } = {}) {
    config = loadConfig();
    // 캡처 중에는 실제 소스 폴더를 건드리지 않게 git 이 아닌 임시 폴더를 가리킨다
    updater = createUpdater({
      root: capture ? process.env.ROOMS_HOME : path.resolve(here, '..', '..'),
      isBusy: () => runs.size > 0,
      relaunch: () => relaunch(),
      notify: (s) => toRenderer('update', s),
      appCommit: process.env.ROOMS_APP_COMMIT || null, // 맥 앱이 넘겨 준 빌드 커밋
    });
    const background = !capture && !process.env.ROOMS_NO_BACKGROUND; // 테스트 등에서 ROOMS_NO_BACKGROUND=1 이면 바깥을 건드리는 작업을 돌리지 않는다
    if (background) updater.start();
    connectClient();
    if (background) {
      refreshUsage();
      setInterval(refreshUsage, 5 * 60 * 1000).unref();
      rescan().catch((e) => console.error('레포 찾기 실패', e)); // 저장된 목록을 먼저 쓰고 백그라운드에서 다시 찾는다
    }
  }

  const stop = () => { for (const ac of runs.values()) ac.abort(); };

  // 창이 다시 앞으로 왔을 때(터미널에서 clone 하고 돌아왔을 때 등)
  const onFocus = () => { rescanIfMissing(); refreshUsage(); };

  return { handlers: wrapped, start, stop, onFocus, getClient: () => client };
}

// 자체 점검: 창 없이 서버·클라이언트·승인 MCP 가 Electron 안에서 도는지 확인한다(claude 실행은 안 한다)
export async function smoke() {
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
        return { hasApprove: tools.includes('approve'), hasGitRead: tools.includes('git_read'), allowWorks: call.behavior === 'allow' };
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
  const ok = required.every((k) => out[k]?.ok) && out.approveMcp?.hasApprove && out.approveMcp?.hasGitRead && out.approveMcp?.allowWorks;
  out.ok = !!ok;
  return out;
}
