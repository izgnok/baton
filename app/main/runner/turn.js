import fs from 'node:fs';
import path from 'node:path';
import { MSG } from '@rooms/shared/protocol.js';
import { preflight } from './preflight.js';
import { pullRoom, collectChanges, readTranscript, roomDirOf } from './sync.js';
import { buildPrompt } from './prompt.js';
import { runClaude } from './claude.js';
import { startApprovalBridge } from './approve.js';

function buildSystemPrompt(roomDir) {
  const indexFile = path.join(roomDir, 'shared', 'memory', 'INDEX.md');
  const index = fs.existsSync(indexFile) ? fs.readFileSync(indexFile, 'utf8') : '(아직 없음)';
  return [
    '이 대화는 여러 사람이 함께 쓰는 채팅방이다. 사용자 메시지의 [방 대화] 는 사람들끼리 나눈 말이고, [요청 - 이름] 이 지금 처리할 요청이다.',
    `방 메모리 폴더: ${roomDir}/shared/memory (목차는 INDEX.md). 이 방에서 새로 알게 된 사실·결정은 이 폴더에 md 로 남기고 INDEX.md 에 한 줄 추가한다.`,
    `문서·HTML 같은 결과물은 ${roomDir}/shared/outputs 에 만든다.`,
    '',
    '[방 메모리 목차]',
    index,
  ].join('\n');
}

/**
 * @claude 한 번 처리. 던지지 않고 결과를 돌려준다
 * @param {{runStart: object, roomState: {repos: object[]}, roomRepoPaths: Record<string, string>,
 *   client: {request: (type: string, payload: object) => Promise<any>},
 *   http: Parameters<typeof pullRoom>[0]['http'],
 *   askUser: (q: object) => Promise<'allow'|'deny'>, closeApproval?: (requestId: number) => void,
 *   claudeBin?: string, heartbeatMs?: number, signal?: AbortSignal}} opts
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function runTurn({
  runStart, roomState, roomRepoPaths, client, http, askUser, closeApproval,
  claudeBin, heartbeatMs = 10000, signal,
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

    const roomDir = roomDirOf(roomId);
    const { snapshot } = await pullRoom({ http, roomId, roomDir, sessionId: runStart.sessionId });
    const prompt = buildPrompt(runStart);
    const systemPrompt = buildSystemPrompt(roomDir);

    bridge = await startApprovalBridge({
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
      addDirs: pre.results.map((r) => r.localPath),
      systemPrompt,
      mcpConfigPath: bridge.mcpConfigPath,
      permissionMode: 'default',
      claudeBin,
      signal,
      onEvent: (ev) => {
        if (ev.type === 'system') return; // hook·init 은 화면에 필요 없다
        send(MSG.RUN_EVENT, { requestId, event: ev }).catch(() => {});
      },
    });

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
