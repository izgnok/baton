import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MSG } from '@baton/shared/protocol.js';
import { preflight } from './preflight.js';
import { pullRoom, collectChanges, readTranscript, roomDirOf } from './sync.js';
import { buildPrompt, buildSystemPrompt } from './prompt.js';
import { runClaude } from './claude.js';
import { startApprovalBridge, ROOM_READ_TOOLS } from './approve.js';
import { pendingChanges, worktreePath, fetchBranch } from './worktree.js';
import { remoteHas } from './codeState.js';
import { syncRepoCode, uploadRepoCode, updateRoomRef } from './codeSync.js';

const memoryIndexOf = (roomDir) => {
  const f = path.join(roomDir, 'shared', 'memory', 'INDEX.md');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '(아직 없음)';
};

// 읽기 허용 규칙. Claude Code 권한 규칙에서 절대 경로는 // 로 시작한다
const readRules = (dirs) => dirs.flatMap((d) => ['Read', 'Glob', 'Grep'].map((t) => `${t}(/${d}/**)`));

const isGitDir = (d) => fs.existsSync(path.join(d, '.git'));

/**
 * @claude 한 번 처리. 던지지 않고 결과를 돌려준다
 * @param {{runStart: object, roomState: {repos: object[]}, roomRepoPaths: Record<string, string>,
 *   client: {request: (type: string, payload: object) => Promise<any>},
 *   http: Parameters<typeof pullRoom>[0]['http'],
 *   askUser: (q: object) => Promise<'allow'|'deny'>, closeApproval?: (requestId: number) => void,
 *   lastApplied?: Record<string, string>, onCodeApplied?: (repoId: number, snapshot: string|null) => void,
 *   ensureSource?: (repo: object) => Promise<string>, onTool?: (name: string, input: object) => Promise<string>,
 *   readDirs?: string[], repoIndex?: {path: string, name: string, remoteUrl: string}[],
 *   model?: string, effort?: string, onRateLimit?: (ev: object) => void, onClaudeOutdated?: () => void,
 *   claudeBin?: string, heartbeatMs?: number, signal?: AbortSignal}} opts
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function runTurn({
  runStart, roomState, roomRepoPaths, client, http, askUser, closeApproval,
  lastApplied = {}, onCodeApplied, ensureSource, onTool, readDirs = [], repoIndex = [], model, effort, onRateLimit, onClaudeOutdated, claudeBin, heartbeatMs = 10000, signal,
}) {
  const { requestId, roomId } = runStart;
  const send = (type, payload) => Promise.resolve().then(() => client.request(type, payload));
  let bridge = null;
  let timer = null;
  let finishSent = false;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-code-'));
  try {
    // 서버는 차례를 넘긴 순간부터 30초를 잰다. 점검·받기가 길어도 끊기지 않게 맨 먼저 시작
    const beat = () => send(MSG.RUN_HEARTBEAT, { requestId }).catch(() => {});
    beat();
    timer = setInterval(beat, heartbeatMs);

    // 시작 때 값을 고정한다(실행 중 방장이 바꿔도 이번 실행은 그대로)
    const repos = roomState.repos.map((r) => ({ ...r }));
    const paths = { ...roomRepoPaths };

    let pre = await preflight(repos, paths);
    // 내 PC 에 원본이 없는 레포는 실패 대신 받아 온다
    if (ensureSource && pre.results.some((r) => r.block === 'MISSING')) {
      for (const r of pre.results.filter((x) => x.block === 'MISSING')) {
        try { paths[r.repoId] = await ensureSource(repos.find((x) => x.id === r.repoId)); } catch { throw new Error('CLONE_FAILED'); }
      }
      pre = await preflight(repos, paths);
    }
    if (!pre.ok) throw new Error(`PREFLIGHT:${pre.results.find((r) => r.block).block}`);

    // 레포마다 방 전용 사본을 서버 코드 상태로 맞춘다. 충돌이면 실행하지 않는다
    const trees = repos.map((r) => ({ repo: r, source: paths[r.id], wt: worktreePath(roomId, r) }));
    const synced = {}; // repoId → 맞춘 서버 스냅샷
    for (const t of trees) {
      const r = await syncRepoCode({
        http, roomId, repo: t.repo, sourcePath: t.source, worktree: t.wt, lastApplied: lastApplied[t.repo.id] ?? null, tmpDir,
      });
      if (r.status === 'conflict') throw new Error('CODE_CONFLICT');
      synced[t.repo.id] = r.snapshot;
    }

    const roomDir = roomDirOf(roomId);
    const { snapshot } = await pullRoom({ http, roomId, roomDir, sessionId: runStart.sessionId });
    const prompt = buildPrompt(runStart);

    // 함께 읽는 폴더·내 PC 레포는 읽기만 허용한다(없어진 폴더는 뺀다)
    const readable = [...new Set(readDirs)].filter((d) => fs.existsSync(d));
    const systemPrompt = buildSystemPrompt({
      requesterName: runStart.requesterName,
      memoryIndex: memoryIndexOf(roomDir),
      repos: trees.map((t) => ({ name: t.repo.name, baseBranch: t.repo.baseBranch, workBranch: t.repo.workBranch, dir: path.relative(roomDir, t.wt) })),
      readDirs: readable,
      indexRepos: repoIndex.map((r) => ({ name: r.name, path: r.path })),
    });
    const readPaths = [...new Set([...repoIndex.map((r) => r.path), ...readable])];
    const readRepos = [...new Set([...readPaths, ...trees.map((t) => t.wt), ...trees.map((t) => t.source)])].filter(isGitDir);

    bridge = await startApprovalBridge({
      readRepos,
      onTool,
      askUser: async (q) => {
        await send(MSG.RUN_APPROVAL, { requestId, state: 'pending', toolName: q.toolName }).catch(() => {});
        const answer = await askUser(q);
        await send(MSG.RUN_APPROVAL, { requestId, state: 'resolved', toolName: q.toolName }).catch(() => {});
        return answer;
      },
    });

    const result = await runClaude({
      cwd: roomDir,
      prompt,
      sessionId: runStart.sessionId ?? undefined,
      fork: runStart.fork === true,
      addDirs: [...trees.map((t) => t.wt), ...readable],
      env: { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1' },
      allowedTools: ['mcp__rooms__git_read', ...ROOM_READ_TOOLS, ...readRules(readPaths)],
      systemPrompt,
      mcpConfigPath: bridge.mcpConfigPath,
      permissionMode: 'default',
      model,
      effort,
      claudeBin,
      signal,
      onEvent: (ev) => {
        // hook·init 은 화면에 필요 없다. 서브에이전트가 끝났다는 알림만 통과(백그라운드 서브에이전트의 "끝남" 표시)
        if (ev.type === 'system' && ev.subtype !== 'task_notification') return;
        // 내 사용량은 서버로 보내지 않고 이 PC 에만 둔다
        if (ev.type === 'rate_limit_event') { try { onRateLimit?.(ev); } catch { /* 저장 실패는 실행을 막지 않는다 */ } return; }
        // 이 맥의 Claude Code 가 오래돼 모델을 못 쓰면 업데이트를 맡긴다(사용자는 [다시 보내기])
        if (ev.type === 'result' && ev.is_error && /or newer is required/i.test(String(ev.result ?? ''))) {
          try { onClaudeOutdated?.(); } catch { /* 업데이트 실패는 실행 결과와 무관 */ }
        }
        send(MSG.RUN_EVENT, { requestId, event: ev }).catch(() => {});
      },
    });

    // 성공했을 때만 알린다. 레포마다 바뀐 것만 올리고, 작업 브랜치가 원격에 생겼으면(push) 기준으로 승격한다
    const codeStates = [];
    const promotedRepoIds = [];
    const tooBig = [];
    const applied = {}; // repoId → 이 맥 사본이 맞춰진 서버 스냅샷
    const results = [];
    for (const t of trees) {
      const { repo } = t;
      let promote = false;
      if (repo.workBranch) {
        // 원격에 닿지 못하면 승격하지 않고 지나간다(다음 실행에서 다시 본다)
        promote = await remoteHas({ worktree: t.wt, branch: repo.workBranch }).catch(() => false);
        if (promote) await fetchBranch(t.source, repo.workBranch);
      }
      const base = promote ? repo.workBranch : repo.baseBranch;
      const up = await uploadRepoCode({
        http, roomId, requestId, repo: { ...repo, baseBranch: base }, worktree: t.wt, prev: promote ? null : synced[repo.id],
        parts: repo.code?.parts ?? 0, tmpDir,
      });
      if (promote) promotedRepoIds.push(repo.id);
      applied[repo.id] = promote ? null : synced[repo.id];
      if (up.entry) {
        codeStates.push(up.entry);
        applied[repo.id] = up.entry.snapshot;
        await updateRoomRef({ sourcePath: t.source, roomId, repoId: repo.id, snapshot: up.entry.snapshot });
      } else if (up.tooBig) tooBig.push(repo.name);
      // 방 작업 폴더의 변경을 채팅에 보여 준다(커밋·push 는 사람이 시킨 뒤 Claude 가 한다)
      try {
        const c = await pendingChanges({ worktreePath: t.wt, branch: base });
        if (c.files.length || c.ahead > 0) results.push({ repoId: repo.id, name: repo.name, branch: base, ...c });
      } catch { /* 이 레포는 건너뛴다 */ }
    }
    if (results.length) await send(MSG.RUN_EVENT, { requestId, event: { type: 'rooms_code_changes', results } }).catch(() => {});
    if (tooBig.length) await send(MSG.RUN_EVENT, { requestId, event: { type: 'rooms_code_too_big', repos: tooBig } }).catch(() => {});

    const transcript = readTranscript({ cwd: roomDir, sessionId: result.sessionId });
    const sharedChanges = collectChanges({ roomDir, snapshot });
    finishSent = true;
    await send(MSG.RUN_FINISH, {
      requestId, transcriptVersion: runStart.transcriptVersion, sessionId: result.sessionId, transcript, sharedChanges,
      codeStates, promotedRepoIds,
    });
    // 서버가 받은 뒤에만 이 맥이 맞춘 상태를 기록한다
    for (const [repoId, snap] of Object.entries(applied)) {
      try { onCodeApplied?.(Number(repoId), snap); } catch { /* 저장 실패는 이미 끝난 실행을 실패로 만들지 않는다 */ }
    }
    return { ok: true };
  } catch (e) {
    const error = e?.message ?? String(e);
    // 올리기 요청이 실패한 경우는 서버가 이미 failed 로 바꿨다
    if (!finishSent) await send(MSG.RUN_FAIL, { requestId, reason: error }).catch(() => {});
    return { ok: false, error };
  } finally {
    clearInterval(timer);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    await bridge?.close().catch(() => {});
    try { closeApproval?.(requestId); } catch { /* 화면 콜백 오류는 무시 */ }
  }
}
