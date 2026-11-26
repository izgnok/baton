// 화면 캡처 모드(ROOMS_SCREENSHOT=<폴더>). 임시 서버·가짜 데이터로 화면을 PNG 로 남긴다
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nativeTheme } from 'electron';
import { MSG } from '@rooms/shared/protocol.js';
import { createServerClient, signup } from './serverClient.js';

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

    const room = await handlers.createRoom({ name: '결제 개선' });
    await b.request(MSG.ROOM_JOIN, { inviteCode: room.inviteCode });
    const roomId = room.id;

    // 레포: 하나는 A 쪽에 연결(정상, 커밋 안 된 변경 있음), 하나는 연결 안 됨
    const origin = path.join(tmp, 'origin.git');
    const work = path.join(tmp, 'work');
    const mine = path.join(tmp, 'payment-api');
    git(['init', '--bare', '-b', 'main', origin]);
    git(['init', '-b', 'main', work]);
    fs.writeFileSync(path.join(work, 'README.md'), '# payment-api\n');
    git(['add', '.'], work);
    git(['commit', '-m', 'init'], work);
    git(['remote', 'add', 'origin', origin], work);
    git(['push', '-u', 'origin', 'main'], work);
    git(['clone', origin, mine]);
    fs.writeFileSync(path.join(mine, 'notes.txt'), 'wip\n');
    const repo1 = await handlers.addRepo({ roomId, name: 'payment-api', remoteUrl: origin, branch: 'main' });
    await handlers.addRepo({ roomId, name: 'payment-web', remoteUrl: 'https://github.com/example/payment-web.git', branch: 'develop' });
    await handlers.linkRepo({ roomId, repoId: repo1.id, localPath: mine });

    // B 가 받는 run.start 마다 차례로 시나리오를 돌린다
    const scripts = [];
    b.on(MSG.RUN_START, ({ runStart }) => { scripts.shift()?.(runStart); });
    const ask = (text, script) => new Promise((resolve, reject) => {
      scripts.push((rs) => script(rs).then(resolve, reject));
      b.request(MSG.CHAT_SEND, { roomId, text }).catch(reject);
    });
    const event = (requestId, ev) => b.request(MSG.RUN_EVENT, { requestId, event: ev });
    const text = (t) => ({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } });
    const tool = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });

    await b.request(MSG.CHAT_SEND, { roomId, text: '결제 실패 원인부터 볼까요?' });
    await handlers.sendMessage({ roomId, text: '좋아요, 로그 먼저 확인해 봐요' });
    await sleep(50);

    await ask('@claude 결제 모듈에서 타임아웃 처리 위치 찾아줘', async ({ requestId, transcriptVersion }) => {
      await event(requestId, text(MD_FIND));
      await event(requestId, tool('t1', 'Read', { file_path: '/Users/haeun/repos/payment-api/src/payment/timeout.js' }));
      await event(requestId, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'export const PAYMENT_TIMEOUT_MS = 5000;' }] } });
      await event(requestId, tool('t2', 'Bash', { command: 'grep -rn "PAYMENT_TIMEOUT_MS" src/payment | head -20' }));
      await event(requestId, text(MD_DONE));
      await b.request(MSG.RUN_FINISH, {
        requestId, transcriptVersion, sessionId: randomUUID(), transcript: '{}\n',
        sharedChanges: [
          { path: 'memory/INDEX.md', contentBase64: b64('- [결제 타임아웃](timeout.md) — 기본 5초\n') },
          { path: 'outputs/정리.md', contentBase64: b64(MD_SUMMARY) },
          { path: 'outputs/report.html', contentBase64: b64(HTML_REPORT) },
        ],
      });
    });

    await ask('@claude 정리 문서 만들어줘', ({ requestId }) => b.request(MSG.RUN_FAIL, { requestId, reason: 'PREFLIGHT:BRANCH_MISMATCH' }));

    // 실행 중 + 승인 대기 상태로 남겨 둔다(신호는 계속 보낸다)
    let runningId = 0;
    await ask('@claude 재시도 정책 초안도 써줘', async ({ requestId }) => {
      runningId = requestId;
      hb = setInterval(() => b.request(MSG.RUN_HEARTBEAT, { requestId }).catch(() => {}), 5000);
      await b.request(MSG.RUN_APPROVAL, { requestId, state: 'pending', toolName: 'Bash' });
    });
    await handlers.sendMessage({ roomId, text: '확인했어요, 이어서 진행해 주세요' });
    await sleep(300);

    const room03 = { roomId, tab: 'shared' };
    const settle = () => sleep(1200); // 레포 점검·목록 불러오기
    const lightDark = async (suffix) => {
      await go('rooms');
      await shot(`02-rooms${suffix}`);
      await go('room', room03);
      await b.request(MSG.RUN_APPROVAL, { requestId: runningId, state: 'pending', toolName: 'Bash' }); // 방을 연 뒤에 온 알림
      await settle();
      await shot(`03-room-chat${suffix}`);
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

    nativeTheme.themeSource = 'dark';
    await sleep(300);
    await lightDark('-dark');
  }

  async function cleanup() {
    clearInterval(hb);
    clients.forEach((c) => c.close());
    await server.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  return { run, cleanup };
}
