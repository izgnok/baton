import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MSG } from '@rooms/shared/protocol.js';
import { loadConfig, saveConfig, setRepoPath, addReadDirs, removeReadDir, setRoomModel, effectiveModel, setCodeApplied, roomsHome } from './localConfig.js';
import { mergeUsage, fetchUsage } from './usage.js';
import { createUpdater } from './updater.js';
import { scanRepos, matchRepo, detectReadDirs } from './repoIndex.js';
import { listSkills } from './skills.js';
import { createServerClient, login, signup, getServerCommit } from './serverClient.js';
import { claudeAuthStatus, claudeLogin, claudeUpdate } from './claudeAuth.js';
import { cloneRepo as gitClone, inspectRepo, preflight, checkRepo, safeDirName } from './runner/preflight.js';
import { runTurn } from './runner/turn.js';
import { roomDirOf } from './runner/sync.js';
import { createSharedSync } from './sharedSync.js';
import { safeJoin } from '@rooms/shared/paths.js';
import { worktreePath, isProtectedBranch, removeWorktree, discardWorktree, listRepoFiles } from './runner/worktree.js';
import { syncRepoCode } from './runner/codeSync.js';
import { snapshot as stateSnapshot } from './runner/codeState.js';
import { createRoomTools } from './roomTools.js';

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
        lastApplied: config.rooms[roomId]?.code ?? {},
        onCodeApplied: (repoId, snapshot) => setApplied(roomId, repoId, snapshot), // 사본이 맞춰진 서버 스냅샷은 이 맥에만 기록한다
        ensureSource: (repo) => cloneSource(roomId, repo),
        onTool: roomToolsFor(roomId, requestId),
        readDirs: config.rooms[roomId]?.readDirs ?? [],
        repoIndex: config.repoIndex?.repos ?? [],
        ...effectiveModel(config, roomId, state.room), // 개인 선택 → 방 기본 → 내 Claude 설정
        onClaudeOutdated: () => { updateClaude('outdated'); },
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
      if (!n) {
        syncShared(roomId).catch(() => {}); // 실행이 올린 결과로 기준(스냅샷)을 다시 맞춘다
        for (const repoId of codeDirty.get(roomId) ?? []) syncCopyInBackground(roomId, repoId); // 실행 중에 온 다른 멤버의 변경
        codeDirty.delete(roomId);
      }
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
        cloneMissing(roomId, m.state);
      } else if (m.type === MSG.ROOM_DELETE) roomCache.delete(m.roomId);
      // 다른 사람이 공유 파일을 바꿨으면 이 PC 에 받아 둔 방만 다시 맞춘다
      else if (m.type === MSG.SHARED_CHANGED && fs.existsSync(roomDirOf(m.roomId))) {
        syncShared(m.roomId).catch((e) => console.error('공유 파일 받기 실패', e));
      } else if (m.type === MSG.CODE_CHANGED) onCodeChanged(m);
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

  // 사본이 마지막으로 맞춰진 서버 스냅샷을 이 맥 설정에 기록한다(바뀌었을 때만)
  function setApplied(roomId, repoId, snapshot) {
    if ((config.rooms[roomId]?.code?.[repoId] ?? null) === (snapshot ?? null)) return;
    config = setCodeApplied(config, roomId, repoId, snapshot);
    saveConfig(config);
  }

  // ---- 공유 사본 맞추기 ----
  const codeSyncs = new Map(); // `${방}:${레포}` → 줄 끝 작업(같은 레포 맞추기는 하나씩)
  const codeDirty = new Map(); // 방 id → 실행 중에 변경 알림이 온 레포 id 들(실행이 끝난 뒤 맞춘다)

  /**
   * 방 레포 사본을 지금 서버 상태로 맞춘다. background: 알림 때 — 직접 고친 사본이면 합치지 않고 local_changes 로 알린다
   * fresh: 서버에서 방 상태를 다시 받아 쓴다
   */
  function syncCopy(roomId, repoId, { background = false, fresh = false } = {}) {
    const key = `${roomId}:${repoId}`;
    const job = (codeSyncs.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (fresh) roomCache.set(roomId, (await req(MSG.ROOM_OPEN, { roomId })).state);
      const repo = (await stateOf(roomId)).repos.find((r) => r.id === repoId);
      const sourcePath = config.rooms[roomId]?.repos?.[repoId];
      if (!repo || !sourcePath) throw new Error('NOT_FOUND');
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-code-'));
      try {
        const r = await syncRepoCode({
          http: client.http, roomId, repo, sourcePath, worktree: worktreePath(roomId, repo),
          lastApplied: config.rooms[roomId]?.code?.[repoId] ?? null, tmpDir, background,
        });
        if (r.status === 'ok') setApplied(roomId, repoId, r.snapshot);
        return r;
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
    codeSyncs.set(key, job);
    job.catch(() => {}).finally(() => { if (codeSyncs.get(key) === job) codeSyncs.delete(key); });
    return job;
  }

  // 알림으로 맞춘다. 이 맥에 그 방 사본이 없으면 다음 실행이 만든다. 결과는 화면에 알린다
  async function syncCopyInBackground(roomId, repoId) {
    let status;
    try {
      const repo = (await stateOf(roomId)).repos.find((r) => r.id === repoId);
      if (!repo || !fs.existsSync(worktreePath(roomId, repo))) return;
      status = (await syncCopy(roomId, repoId, { background: true })).status;
    } catch (e) {
      console.error('사본 맞추기 실패', e);
      status = 'failed';
    }
    toRenderer('rooms:event', { type: 'local.code', roomId, repoId, status });
  }

  // 다른 멤버가 사본을 바꿨다. 이 방이 이 맥에서 실행 중이면 끝난 뒤에 맞춘다
  function onCodeChanged(m) {
    const roomId = Number(m.roomId);
    const repoId = Number(m.repoId);
    if (m.userId === config.user?.id || !config.rooms[roomId]?.repos?.[repoId]) return; // 내가 올린 것·원본이 없는 레포
    if (runningRooms.has(roomId)) {
      if (!codeDirty.has(roomId)) codeDirty.set(roomId, new Set());
      codeDirty.get(roomId).add(repoId);
      return;
    }
    syncCopyInBackground(roomId, repoId);
  }

  // ---- 방 도구(Claude 가 방 설정을 바꾸는 MCP 도구) ----
  // 사본 폴더를 지운다. 서버에 올리지 않은 변경(마지막으로 맞춘 상태와 다른 내용)이 있으면 던진다
  async function removeCopy(roomId, repoId) {
    const repo = (await stateOf(roomId)).repos.find((r) => r.id === repoId);
    if (!repo) return;
    const wt = worktreePath(roomId, repo);
    const last = config.rooms[roomId]?.code?.[repoId] ?? null;
    if (fs.existsSync(wt)) {
      const s = await stateSnapshot({ worktree: wt, base: `origin/${repo.baseBranch}`, prev: last }).catch(() => null);
      if (!s || (last ? !s.same : !s.empty)) throw new Error('이 맥 사본에 서버에 올리지 않은 변경이 있어요. 먼저 실행을 한 번 더 하거나 push 해 주세요');
    }
    await discardWorktree({ sourcePath: config.rooms[roomId]?.repos?.[repoId], worktreePath: wt });
    setApplied(roomId, repoId, null);
  }

  function roomToolsFor(roomId, requestId) {
    return createRoomTools({
      roomId,
      requestId,
      client,
      getState: () => roomCache.get(roomId),
      repoIndex: config.repoIndex?.repos ?? [],
      getSource: (repoId) => config.rooms[roomId]?.repos?.[repoId],
      setSource: (repoId, localPath) => { linkLocal(roomId, repoId, localPath); sendMemberStatus(roomId); toRenderer('rooms:event', { type: 'local.repos', roomId }); },
      worktreeOf: (repo) => worktreePath(roomId, repo),
      syncRepo: (repoId) => syncCopy(roomId, repoId, { fresh: true }),
      removeCopy: (repoId) => removeCopy(roomId, repoId),
    });
  }

  // ---- 자동 clone ----
  const cloneFailed = new Set(); // 실패한 `${방}:${레포}:${원격}` (앱을 다시 켜기 전까지 자동으로는 다시 안 한다. 실행 때는 다시 시도한다)
  const cloneQueued = new Set();
  let cloneChain = Promise.resolve(); // 한 번에 하나

  // 내 PC 에서 찾은 같은 원격의 레포가 있으면 그것을, 없으면 받아서 이 방 레포에 연결한다
  async function cloneSource(roomId, repo) {
    let localPath = matchRepo(config.repoIndex, repo.remoteUrl);
    if (!localPath) {
      try {
        localPath = await gitClone({ remoteUrl: repo.remoteUrl, branch: repo.baseBranch, name: repo.name });
      } catch (e) {
        // 다른 방에서 이미 받아 둔 폴더면 그대로 쓴다
        const dest = path.join(roomsHome(), 'repos', safeDirName(repo.name));
        if (e.message !== 'DEST_EXISTS' || !(await checkRepo({ localPath: dest, remoteUrl: repo.remoteUrl })).ok) throw e;
        localPath = dest;
      }
      config = { ...config, repoIndex: { scannedAt: config.repoIndex?.scannedAt ?? 0, repos: [...(config.repoIndex?.repos ?? []), { path: localPath, name: repo.name, remoteUrl: repo.remoteUrl }] } };
    }
    linkLocal(roomId, repo.id, localPath);
    sendMemberStatus(roomId);
    toRenderer('rooms:event', { type: 'local.repos', roomId });
    return localPath;
  }

  // 연결 안 됐고 내 PC 레포 목록에도 없는 방 레포는 백그라운드로 받는다(rescanIfMissing 과 같은 조건)
  function cloneMissing(roomId, state) {
    if (process.env.ROOMS_SCREENSHOT || process.env.ROOMS_NO_BACKGROUND) return;
    for (const repo of state.repos) {
      const key = `${roomId}:${repo.id}:${repo.remoteUrl}`;
      if (config.rooms[roomId]?.repos?.[repo.id] || matchRepo(config.repoIndex, repo.remoteUrl) || cloneFailed.has(key) || cloneQueued.has(key)) continue;
      cloneQueued.add(key);
      cloneChain = cloneChain.then(async () => {
        await scanning?.catch(() => {}); // 레포 찾기가 끝나면 이미 있는 레포가 연결될 수 있다
        if (config.rooms[roomId]?.repos?.[repo.id]) return;
        try { await cloneSource(roomId, repo); } catch (e) { cloneFailed.add(key); console.error(`레포 받기 실패: ${repo.name}`, e); }
      }).finally(() => cloneQueued.delete(key));
    }
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
  // Claude Code 업데이트(동시에 한 번만). 바뀌었거나, 오래돼 실패한 경우엔 결과를 화면에 알린다
  let claudeUpdating = null;
  function updateClaude(reason) {
    claudeUpdating ??= claudeUpdate().then((r) => {
      claudeCache = { at: 0, ok: false }; // 로그인 상태도 다시 읽게
      if (r.updated || reason === 'outdated') emit('claude:update', { ...r, reason });
      return r;
    }).finally(() => { claudeUpdating = null; });
    return claudeUpdating;
  }

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
    res.results = await Promise.all(res.results.map(async (r) => {
      const repo = state.repos.find((x) => x.id === r.repoId);
      const wt = worktreePath(roomId, repo);
      const exists = fs.existsSync(wt);
      // 작업 브랜치(원격에 아직 없음)가 있으면 그 이름. 보호 판정은 push 할 브랜치(작업 브랜치, 없으면 기준) 기준
      // indexed: 내 PC 레포 목록에 있는 경로(자동 연결 대상)
      return { ...r, worktreePath: wt, worktreeExists: exists, pendingBranch: repo.workBranch || null, protected: isProtectedBranch(repo.workBranch || repo.baseBranch), indexed: !!r.localPath && indexed.has(r.localPath) };
    }));
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
        const r = await removeWorktree({ sourcePath, worktreePath: wt, branch: repo.baseBranch });
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
    joinPublicRoom: (a) => req(MSG.ROOM_JOIN_PUBLIC, a),
    forkRoom: (a) => req(MSG.ROOM_FORK, a),
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
      const repo = (await stateOf(roomId)).repos.find((r) => r.id === repoId);
      if (!repo) throw new Error('NOT_FOUND');
      await cloneSource(roomId, repo);
      return checkRepos({ roomId });
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
      // Claude Code 를 최신으로: 시작 10초 뒤, 그 뒤 6시간마다(새 모델은 새 버전을 요구한다)
      setTimeout(() => updateClaude('auto'), 10000).unref();
      setInterval(() => updateClaude('auto'), 6 * 60 * 60 * 1000).unref();
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
