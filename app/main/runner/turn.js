import fs from 'node:fs';
import path from 'node:path';
import { MSG } from '@rooms/shared/protocol.js';
import { preflight } from './preflight.js';
import { pullRoom, collectChanges, readTranscript, roomDirOf } from './sync.js';
import { buildPrompt, buildSystemPrompt } from './prompt.js';
import { runClaude } from './claude.js';
import { startApprovalBridge } from './approve.js';
import { syncWorktree, pendingChanges, worktreePath } from './worktree.js';

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
 *   readDirs?: string[], repoIndex?: {path: string, name: string, remoteUrl: string}[],
 *   model?: string, effort?: string, onRateLimit?: (ev: object) => void,
 *   claudeBin?: string, heartbeatMs?: number, signal?: AbortSignal}} opts
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function runTurn({
  runStart, roomState, roomRepoPaths, client, http, askUser, closeApproval,
  readDirs = [], repoIndex = [], model, effort, onRateLimit, claudeBin, heartbeatMs = 10000, signal,
}) {
  const { requestId, roomId } = runStart;
  const send = (type, payload) => Promise.resolve().then(() => client.request(type, payload));
  let bridge = null;
  let timer = null;
  let finishSent = false;
  try {
    // 서버는 차례를 넘긴 순간부터 30초를 잰다. 점검·받기가 길어도 끊기지 않게 맨 먼저 시작
    const beat = () => send(MSG.RUN_HEARTBEAT, { requestId }).catch(() => {});
    beat();
    timer = setInterval(beat, heartbeatMs);

    // 시작 때 값을 고정한다(실행 중 방장이 바꿔도 이번 실행은 그대로)
    const repos = roomState.repos.map((r) => ({ ...r }));
    const paths = { ...roomRepoPaths };

    const pre = await preflight(repos, paths);
    if (!pre.ok) throw new Error(`PREFLIGHT:${pre.results.find((r) => r.block).block}`);

    // 레포마다 방 전용 작업 폴더를 방 브랜치에 맞춘다. 실패하면 사유 그대로 막는다
    const trees = repos.map((r) => ({ repo: r, source: paths[r.id], wt: worktreePath(roomId, r) }));
    for (const t of trees) await syncWorktree({ sourcePath: t.source, worktreePath: t.wt, branch: t.repo.branch });

    const roomDir = roomDirOf(roomId);
    const { snapshot } = await pullRoom({ http, roomId, roomDir, sessionId: runStart.sessionId });
    const prompt = buildPrompt(runStart);

    // 함께 읽는 폴더·내 PC 레포는 읽기만 허용한다(없어진 폴더는 뺀다)
    const readable = [...new Set(readDirs)].filter((d) => fs.existsSync(d));
    const systemPrompt = buildSystemPrompt({
      requesterName: runStart.requesterName,
      memoryIndex: memoryIndexOf(roomDir),
      repos: trees.map((t) => ({ name: t.repo.name, branch: t.repo.branch, dir: path.relative(roomDir, t.wt) })),
      readDirs: readable,
      indexRepos: repoIndex.map((r) => ({ name: r.name, path: r.path })),
    });
    const readPaths = [...new Set([...repoIndex.map((r) => r.path), ...readable])];
    const readRepos = [...new Set([...readPaths, ...trees.map((t) => t.wt), ...trees.map((t) => t.source)])].filter(isGitDir);

    bridge = await startApprovalBridge({
      readRepos,
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
      addDirs: [...trees.map((t) => t.wt), ...readable],
      env: { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1' },
      allowedTools: ['mcp__rooms__git_read', ...readRules(readPaths)],
      systemPrompt,
      mcpConfigPath: bridge.mcpConfigPath,
      permissionMode: 'default',
      model,
      effort,
      claudeBin,
      signal,
      onEvent: (ev) => {
        if (ev.type === 'system') return; // hook·init 은 화면에 필요 없다
        // 내 사용량은 서버로 보내지 않고 이 PC 에만 둔다
        if (ev.type === 'rate_limit_event') { try { onRateLimit?.(ev); } catch { /* 저장 실패는 실행을 막지 않는다 */ } return; }
        send(MSG.RUN_EVENT, { requestId, event: ev }).catch(() => {});
      },
    });

    // 성공했을 때만 방 작업 폴더의 변경을 채팅에 보여 준다(커밋·push 는 사람이 시킨 뒤 Claude 가 한다)
    const results = [];
    for (const t of trees) {
      try {
        const c = await pendingChanges({ worktreePath: t.wt, branch: t.repo.branch });
        if (c.files.length || c.ahead > 0) results.push({ repoId: t.repo.id, name: t.repo.name, branch: t.repo.branch, ...c });
      } catch { /* 이 레포는 건너뛴다 */ }
    }
    if (results.length) await send(MSG.RUN_EVENT, { requestId, event: { type: 'rooms_code_changes', results } }).catch(() => {});

    const transcript = readTranscript({ cwd: roomDir, sessionId: result.sessionId });
    const sharedChanges = collectChanges({ roomDir, snapshot });
    finishSent = true;
    await send(MSG.RUN_FINISH, {
      requestId, transcriptVersion: runStart.transcriptVersion, sessionId: result.sessionId, transcript, sharedChanges,
    });
    return { ok: true };
  } catch (e) {
    const error = e?.message ?? String(e);
    // 올리기 요청이 실패한 경우는 서버가 이미 failed 로 바꿨다
    if (!finishSent) await send(MSG.RUN_FAIL, { requestId, reason: error }).catch(() => {});
    return { ok: false, error };
  } finally {
    clearInterval(timer);
    await bridge?.close().catch(() => {});
    try { closeApproval?.(requestId); } catch { /* 화면 콜백 오류는 무시 */ }
  }
}
