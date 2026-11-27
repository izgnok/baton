// 화면 캡처 모드(ROOMS_SCREENSHOT=<폴더>). 임시 서버·가짜 데이터로 화면을 PNG 로 남긴다
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nativeTheme } from 'electron';
import { MSG } from '@rooms/shared/protocol.js';
import { createServerClient, signup } from './serverClient.js';
import { saveConfig } from './localConfig.js';
import { syncWorktree, worktreePath } from './runner/worktree.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (text) => Buffer.from(text).toString('base64');

const MD_FIND = [
  '결제 모듈에서 타임아웃을 처리하는 위치를 찾아봤어요.',
  '',
  '## 찾은 위치',
  '',
  '- `src/payment/timeout.js` — 타임아웃 값 정의 (기본 5초)',
  '- `src/payment/client.js:42` — 요청 중단 처리',
  '',
  '```js',
  'const controller = new AbortController();',
  'setTimeout(() => controller.abort(), PAYMENT_TIMEOUT_MS);',
  '```',
].join('\n');
const MD_DONE = [
  '정리해서 `outputs/정리.md` 에 남겼어요. 재시도 정책도 같이 볼까요?',
  '',
  '참고로 <img src=x onerror=alert(1)> 같은 태그는 실행되지 않고 글자로 보여요.',
].join('\n');
const MD_SUMMARY = [
  '# 결제 타임아웃 정리',
  '',
  '## 현재 동작',
  '',
  '- 타임아웃은 **5초**, 재시도는 없음',
  '- 실패하면 사용자에게 "결제 실패" 만 보임',
  '',
  '## 다음 할 일',
  '',
  '1. 타임아웃 값을 설정으로 분리',
  '2. 재시도 정책 정하기',
  '3. 실패 사유를 화면에 구분해서 보여 주기',
  '',
  '| 위치 | 내용 |',
  '|---|---|',
  '| `timeout.js` | 값 정의 |',
  '| `client.js` | 중단 처리 |',
].join('\n');
const DIFF = [
  'diff --git a/src/payment/timeout.js b/src/payment/timeout.js',
  'index 1a2b3c4..5d6e7f8 100644',
  '--- a/src/payment/timeout.js',
  '+++ b/src/payment/timeout.js',
  '@@ -1,3 +1,4 @@',
  ' // 결제 타임아웃',
  '-export const PAYMENT_TIMEOUT_MS = 5000;',
  '+export const PAYMENT_TIMEOUT_MS = Number(process.env.PAYMENT_TIMEOUT_MS ?? 5000);',
  '+export const PAYMENT_RETRY = 2;',
  ' export default PAYMENT_TIMEOUT_MS;',
].join('\n');
const HTML_REPORT = `<!doctype html><html><head><meta charset="utf-8"><style>
body{font-family:sans-serif;padding:24px;color:#191F28}h1{color:#3182F6}.card{background:#F2F4F6;border-radius:16px;padding:16px;margin-top:12px}
</style></head><body><h1>결제 타임아웃 보고서</h1><div class="card">평균 응답 3.2초, 상위 1% 는 5초 초과</div>
<div class="card">이 카드 아래에 스크립트가 있어도 실행되지 않아요</div>
<script>document.body.append('스크립트가 실행됨')</script></body></html>`;

function git(args, cwd) {
  const who = { GIT_AUTHOR_NAME: 'cap', GIT_AUTHOR_EMAIL: 'cap@example.com', GIT_COMMITTER_NAME: 'cap', GIT_COMMITTER_EMAIL: 'cap@example.com' };
  return execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, ...who, GIT_TERMINAL_PROMPT: '0' } });
}

/** 서버를 띄우고 환경을 잡는다. 설정을 읽기 전에 불러야 한다 */
export async function startCapture(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-capture-'));
  process.env.ROOMS_HOME ||= path.join(tmp, 'home');
  // 실제 claude 설정을 읽지 않도록 가짜 claude 를 쓴다
  const fake = path.join(tmp, 'claude');
  fs.writeFileSync(fake, `#!/bin/sh\necho '{"loggedIn":true,"email":"jihwan@example.com","orgName":"예시 팀","subscriptionType":"team"}'\n`, { mode: 0o755 });
  process.env.CLAUDE_BIN = fake;
  // 실제 ~/.claude 의 스킬 이름이 캡처에 나오지 않게 가짜 설정 폴더를 쓴다
  const claudeDir = path.join(tmp, 'claude-config');
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  fs.mkdirSync(path.join(claudeDir, 'skills', 'summarize'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'skills', 'summarize', 'SKILL.md'), '---\nname: summarize\ndescription: 긴 글을 세 줄로 요약해요\n---\n');
  fs.mkdirSync(path.join(claudeDir, 'skills', 'review-pr'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'skills', 'review-pr', 'SKILL.md'), '---\nname: review-pr\ndescription: 변경한 코드를 검토해요\n---\n');
  // 내 PC 레포 목록에 payment-api 가 있는 상태(레포 탭의 "자동 연결됨" 표시)
  const mine = path.join(tmp, 'payment-api');
  const originPath = path.join(tmp, 'origin.git');
  saveConfig({ serverUrl: null, token: null, rooms: {}, repoIndex: { scannedAt: Date.now() - 3600 * 1000, repos: [{ path: mine, name: 'payment-api', remoteUrl: originPath }] } });
  const { startServer } = await import('../../server/src/index.js');
  const server = await startServer({ port: 0, dataDir: path.join(tmp, 'data') });
  const url = `http://localhost:${server.port}`;
  const clients = [];
  let hb = null;

  async function run({ handlers, getWin, toRenderer, getClient }) {
    const js = (code) => getWin().webContents.executeJavaScript(code);
    const shot = async (name) => {
      await sleep(500);
      await js('document.fonts.ready.then(() => true)');
      fs.writeFileSync(path.join(outDir, `${name}.png`), (await getWin().webContents.capturePage()).toPNG());
    };
    const go = async (view, opts = {}) => { await js(`window.__debug.go(${JSON.stringify(view)}, ${JSON.stringify(opts)})`); };
    const waitFor = async (fn, what) => {
      for (let i = 0; i < 100; i++) { if (await fn()) return; await sleep(100); }
      throw new Error(`대기 시간 초과: ${what}`);
    };

    nativeTheme.themeSource = 'light'; // 라이트 장면은 OS 설정과 상관없이 라이트로
    await waitFor(() => js('!!window.__debug'), '화면 로드');
    await handlers.logout(); // 로그아웃 상태에서 시작(env 로 받은 폴더에 예전 로그인이 있을 수 있다)
    await go('login', { serverUrl: url });
    await shot('01-login');

    // 사용자 A 는 앱 화면 API 로 가입한다
    await js(`window.rooms.signup(${JSON.stringify({ serverUrl: url, email: 'jihwan@example.com', password: 'password1', name: '지환' })})`);
    await waitFor(() => getClient()?.connected, 'A 연결');

    // 사용자 B 는 스크립트 클라이언트
    const bSession = await signup(url, { email: 'haeun@example.com', password: 'password1', name: '하은' });
    const b = createServerClient({ serverUrl: url, token: bSession.token });
    clients.push(b);
    await waitFor(() => b.connected, 'B 연결');
    const cSession = await signup(url, { email: 'minsu@example.com', password: 'password1', name: '민수' });
    const c = createServerClient({ serverUrl: url, token: cSession.token });
    clients.push(c);
    await waitFor(() => c.connected, 'C 연결');

    const room = await handlers.createRoom({ name: '결제 개선' });
    await b.request(MSG.ROOM_JOIN, { inviteCode: room.inviteCode });
    await c.request(MSG.ROOM_JOIN, { inviteCode: room.inviteCode });
    const roomId = room.id;
    // 멤버 탭의 연결 요약
    await b.request(MSG.MEMBER_STATUS, { roomId, status: { repos: ['payment-api'], readDirs: ['notes'], claude: true } });
    await c.request(MSG.MEMBER_STATUS, { roomId, status: { repos: [], readDirs: [], claude: false } });
    // 방 기본 모델·노력(방장 = A)
    await handlers.setRoomSettings({ roomId, defaultModel: 'opus', defaultEffort: 'high' });
    const notes = path.join(tmp, 'notes');
    fs.mkdirSync(notes);

    // 레포: 하나는 A 쪽에 연결(정상, 방 작업 폴더 있음), 하나는 연결 안 됨
    const origin = originPath;
    const work = path.join(tmp, 'work');
    git(['init', '--bare', '-b', 'main', origin]);
    git(['init', '-b', 'main', work]);
    fs.writeFileSync(path.join(work, 'README.md'), '# payment-api\n');
    fs.mkdirSync(path.join(work, 'src', 'payment'), { recursive: true });
    fs.writeFileSync(path.join(work, 'src', 'payment', 'timeout.js'), 'export const PAYMENT_TIMEOUT_MS = 5000;\n');
    fs.writeFileSync(path.join(work, 'src', 'payment', 'client.js'), 'export const send = () => {};\n');
    git(['add', '.'], work);
    git(['commit', '-m', 'init'], work);
    git(['remote', 'add', 'origin', origin], work);
    git(['push', '-u', 'origin', 'main'], work);
    git(['push', 'origin', 'main:refs/heads/feature/ABC-123'], work);
    git(['clone', origin, mine]);
    const repo1 = await handlers.addRepo({ roomId, name: 'payment-api', remoteUrl: origin, branch: 'feature/ABC-123' });
    await handlers.addRepo({ roomId, name: 'payment-web', remoteUrl: 'https://github.com/example/payment-web.git', branch: 'develop' });
    await handlers.linkRepo({ roomId, repoId: repo1.id, localPath: mine });
    // 방 작업 폴더가 이미 만들어진 상태
    await syncWorktree({ sourcePath: mine, worktreePath: worktreePath(roomId, repo1), branch: 'feature/ABC-123' });
    await handlers.addReadDir({ roomId, path: notes });

    // B 가 받는 run.start 마다 차례로 시나리오를 돌린다
    const scripts = [];
    b.on(MSG.RUN_START, ({ runStart }) => { scripts.shift()?.(runStart); });
    const ask = (text, script) => new Promise((resolve, reject) => {
      scripts.push((rs) => script(rs).then(resolve, reject));
      b.request(MSG.CHAT_SEND, { roomId, text }).catch(reject);
    });
    const event = (requestId, ev) => b.request(MSG.RUN_EVENT, { requestId, event: ev });
    const text = (t) => ({ type: 'assistant', message: { model: 'claude-opus-4-7', content: [{ type: 'text', text: t }] } });
    const tool = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });

    await b.request(MSG.CHAT_SEND, { roomId, text: '결제 실패 원인부터 볼까요?' });
    await handlers.sendMessage({ roomId, text: '좋아요, 로그 먼저 확인해 봐요' });
    await c.request(MSG.CHAT_SEND, { roomId, text: '저는 재시도 쪽을 볼게요' });
    await sleep(50);

    await ask('@claude 결제 모듈에서 타임아웃 처리 위치 찾아줘', async ({ requestId, transcriptVersion }) => {
      await event(requestId, text(MD_FIND));
      await event(requestId, tool('t1', 'Read', { file_path: '/Users/haeun/repos/payment-api/src/payment/timeout.js' }));
      await event(requestId, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'export const PAYMENT_TIMEOUT_MS = 5000;' }] } });
      await event(requestId, tool('t2', 'Bash', { command: 'grep -rn "PAYMENT_TIMEOUT_MS" src/payment | head -20' }));
      await event(requestId, text(MD_DONE));
      await event(requestId, {
        type: 'rooms_code_changes',
        results: [{
          repoId: repo1.id, name: 'payment-api', branch: 'feature/ABC-123', ahead: 1, truncated: false,
          files: [{ status: 'M', path: 'src/payment/timeout.js' }, { status: '??', path: 'docs/retry.md' }],
          diff: DIFF,
        }],
      });
      await b.request(MSG.RUN_FINISH, {
        requestId, transcriptVersion, sessionId: randomUUID(), transcript: '{}\n',
        sharedChanges: [
          { path: 'memory/INDEX.md', contentBase64: b64('- [결제 타임아웃](timeout.md) — 기본 5초\n') },
          { path: 'outputs/정리.md', contentBase64: b64(MD_SUMMARY) },
          { path: 'outputs/report.html', contentBase64: b64(HTML_REPORT) },
        ],
      });
    });

    await ask('@claude 정리 문서 만들어줘', ({ requestId }) => b.request(MSG.RUN_FAIL, { requestId, reason: 'BRANCH_NOT_ON_REMOTE' }));

    // 실행 중 + 승인 대기 상태로 남겨 둔다(신호는 계속 보낸다)
    let runningId = 0;
    await ask('@claude 재시도 정책 초안도 써줘', async ({ requestId }) => {
      runningId = requestId;
      hb = setInterval(() => b.request(MSG.RUN_HEARTBEAT, { requestId }).catch(() => {}), 5000);
      await b.request(MSG.RUN_APPROVAL, { requestId, state: 'pending', toolName: 'Bash' });
    });
    await handlers.sendMessage({ roomId, text: '확인했어요, 이어서 진행해 주세요' });
    // 대기 중이던 요청을 중단한 상태(다시 보내기 버튼)
    const queued = await handlers.sendMessage({ roomId, text: '@claude 이 내용도 문서에 넣어줘' });
    await handlers.cancelRequest({ requestId: queued.id });
    await sleep(300);

    const room03 = { roomId, tab: 'shared' };
    const settle = () => sleep(1200); // 레포 점검·목록 불러오기
    const now = Date.now();
    toRenderer('usage', {
      fiveHour: { utilization: 0.21, resetsAt: now + 3 * 3600 * 1000, status: 'allowed' },
      sevenDay: { utilization: 0.83, resetsAt: now + 2 * 24 * 3600 * 1000, status: 'allowed_warning' },
      updatedAt: now - 5 * 60 * 1000,
    });
    const lightDark = async (suffix) => {
      await go('rooms');
      await shot(`02-rooms${suffix}`);
      await go('room', room03);
      await b.request(MSG.RUN_APPROVAL, { requestId: runningId, state: 'pending', toolName: 'Bash' }); // 방을 연 뒤에 온 알림
      await settle();
      await shot(`03-room-chat${suffix}`);
      // Claude 답(모델 표시)과 바뀐 코드 카드가 보이게 위로 스크롤하고, diff 를 펼쳐 둔다
      await js(`(() => { const d = document.querySelector('.code-diff-box'); if (d) d.open = true; })()`);
      await sleep(100);
      await js(`(() => { const m = document.querySelector('.messages'); const c = document.querySelector('.code-card'); m.scrollTop += c.getBoundingClientRect().bottom - m.getBoundingClientRect().bottom + 40; })()`);
      await shot(`03b-room-code${suffix}`);
      await js(`(() => { const d = document.querySelector('.code-diff-box'); if (d) d.open = false; })()`);
      await js(`document.querySelector('.messages').scrollTop = 0`); // 사람별 색이 보이는 맨 위
      await shot(`03c-room-people${suffix}`);
      toRenderer('approval:ask', {
        id: 'capture', requestId: runningId, roomId, toolName: 'Write',
        input: { file_path: '/Users/hana/claude-rooms/1/shared/outputs/재시도-정책.md', content: `# 재시도 정책 초안\n\n${'- 실패 시 지수 백오프로 최대 3회 재시도\n'.repeat(60)}` },
      });
      await shot(`08-approval${suffix}`);
      toRenderer('approval:close', { requestId: runningId });
    };

    await lightDark('');
    await go('room', { roomId, tab: 'repos' });
    await settle();
    await shot('04-room-repos');
    // 미리보기는 파일을 받아 온 뒤 시트가 올라온다. 앞 시트가 닫히는 애니메이션이 끝날 때까지 기다린다
    await go('room', { roomId, tab: 'shared', preview: 'outputs/정리.md' });
    await settle();
    await sleep(800);
    await shot('05-shared-md');
    await go('room', { roomId, tab: 'shared', preview: 'outputs/report.html' });
    await settle();
    await sleep(800);
    await shot('06-shared-html');
    await go('room', { roomId, tab: 'members' });
    await settle();
    await shot('07-members');

    // 자동완성 팝업: / 로 명령·스킬, @ 로 멤버·파일
    const typeInto = (t) => js(`(() => { const i = document.querySelector('.composer textarea'); i.focus(); i.value = ${JSON.stringify(t)}; i.setSelectionRange(i.value.length, i.value.length); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await go('room', { roomId, tab: 'repos' });
    await settle();
    await typeInto('/');
    await sleep(300);
    await shot('09-autocomplete');
    await typeInto('@ti');
    await sleep(700); // 레포 파일 검색(200ms 디바운스)
    await shot('09b-autocomplete-mention');
    await typeInto('');

    // 업데이트 띠(가짜 알림)
    toRenderer('update', { count: 3, subjects: ['방 목록에 사용량 막대', '입력창 자동완성', '서버 자동 재시작'], serverMismatch: true });
    await sleep(300);
    await shot('10-update');
    toRenderer('update', { count: 0, subjects: [], serverMismatch: false });

    nativeTheme.themeSource = 'dark';
    await sleep(300);
    await lightDark('-dark');
    await go('room', { roomId, tab: 'repos' });
    await settle();
    await shot('04-room-repos-dark');
    await go('room', { roomId, tab: 'members' });
    await settle();
    await shot('07-members-dark');
    await typeInto('/');
    await sleep(300);
    await shot('09-autocomplete-dark');
  }

  async function cleanup() {
    clearInterval(hb);
    clients.forEach((c) => c.close());
    await server.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  return { run, cleanup };
}
