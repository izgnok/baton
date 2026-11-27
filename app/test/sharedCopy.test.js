import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../server/src/index.js';

// 서버 1대 + 맥 여러 대(코어 프로세스, 각자 ROOMS_HOME·가짜 claude)로 공유 사본 흐름을 끝까지 돌려 본다
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fx = path.join(appDir, 'test', 'fixtures');
const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString().trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.chmodSync(path.join(fx, 'fake-claude.mjs'), 0o755);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-e2e-'));
const procs = [];
let server;
after(async () => {
  await Promise.all(procs.map((p) => new Promise((resolve) => { if (p.exitCode !== null) return resolve(); p.once('exit', resolve); p.kill(); })));
  await server?.close();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
});

async function until(fn, what, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`시간 초과: ${what}`);
    await sleep(50);
  }
}

// 코어를 띄우고 call(핸들러 호출)·events(화면으로 가는 알림)를 돌려준다
function mac(label, seqFiles, extraEnv = {}) {
  const home = path.join(tmp, `${label}-home`);
  const child = spawn(process.execPath, ['main/core.js'], {
    cwd: appDir,
    env: {
      ...process.env, ROOMS_HOME: home, ROOMS_NO_BACKGROUND: '1', CLAUDE_CONFIG_DIR: path.join(tmp, `${label}-claude`),
      CLAUDE_BIN: path.join(fx, 'fake-claude.mjs'), FAKE_STREAM: path.join(fx, 'stream-ok.jsonl'), FAKE_TRANSCRIPT: 'x',
      FAKE_REPO_WRITE_SEQ: JSON.stringify(seqFiles), FAKE_SEQ_FILE: path.join(tmp, `${label}-seq`), ...extraEnv,
    },
  });
  procs.push(child);
  const lines = [];
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    const parts = buf.split('\n');
    buf = parts.pop();
    for (const l of parts) { try { lines.push(JSON.parse(l)); } catch { /* 로그 줄 */ } }
  });
  child.stderr.on('data', () => {});
  let id = 0;
  const call = async (name, args = {}) => {
    const mine = ++id;
    child.stdin.write(`${JSON.stringify({ id: mine, call: name, args })}\n`);
    const m = await until(() => lines.find((x) => x.id === mine), `응답 ${name}`);
    if (!m.ok) throw new Error(`${name}: ${m.error}`);
    return m.data;
  };
  const localCode = () => lines.filter((x) => x.event === 'rooms:event' && x.payload?.type === 'local.code').map((x) => x.payload);
  const m = { label, home, call, localCode, token: null, wt: null, src: null };
  m.token = () => JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).token;
  m.config = () => JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  return m;
}

test('두 맥: A 의 실행이 올린 변경이 B 사본에 알림으로 맞춰지고, B 의 실행은 그 위의 증분을 올린다. 사본이 없는 맥은 자동으로 받는다', { timeout: 120000 }, async () => {
  // 원격(bare) + 서버
  const bare = path.join(tmp, 'r.git');
  const seed = path.join(tmp, 'seed');
  fs.mkdirSync(seed);
  g(seed, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(seed, 'README.md'), 'r\n');
  g(seed, 'add', '.');
  g(seed, 'commit', '-q', '-m', 'init');
  g(tmp, 'init', '-q', '--bare', '-b', 'main', bare);
  g(seed, 'remote', 'add', 'origin', bare);
  g(seed, 'push', '-q', 'origin', 'main');
  server = await startServer({ port: 0, dataDir: path.join(tmp, 'data'), commit: null });
  const serverUrl = `http://localhost:${server.port}`;

  const A = mac('A', ['a0.txt']);
  const B = mac('B', ['b0.txt', 'b1.txt']);
  const C = mac('C', ['c0.txt']);
  for (const [m, name] of [[A, 'a'], [B, 'b'], [C, 'c']]) await m.call('signup', { serverUrl, email: `${name}@x.com`, password: 'password1', name });
  const room = await A.call('createRoom', { name: '공유 사본' });
  await B.call('joinRoom', { inviteCode: room.inviteCode });
  await C.call('joinRoom', { inviteCode: room.inviteCode });
  const roomId = room.id;
  const repo = await A.call('addRepo', { roomId, name: 'r', remoteUrl: bare, branch: 'main' });
  for (const m of [A, B]) {
    const clone = path.join(tmp, `${m.label}-clone`);
    g(tmp, 'clone', '-q', bare, clone);
    await m.call('openRoom', { roomId });
    await m.call('linkRepo', { roomId, repoId: repo.id, localPath: clone });
    m.src = clone;
    m.wt = path.join(m.home, String(roomId), 'repos', `${repo.id}-r`);
  }
  C.wt = path.join(C.home, String(roomId), 'repos', `${repo.id}-r`);
  await C.call('openRoom', { roomId }); // C 는 레포를 연결하지 않는다

  const chat = (m, text) => m.call('sendMessage', { roomId, text });
  const parts = async () => (await (await fetch(`${serverUrl}/rooms/${roomId}/code/${repo.id}`, { headers: { authorization: `Bearer ${A.token()}` } })).json()).parts;
  const waitParts = (n) => until(async () => (await parts()).length === n && parts(), `조각 ${n}개`);
  const lastApplied = (m) => m.config().rooms[roomId]?.code?.[repo.id];

  // 1) B 가 실행: 사본이 처음 생기고 조각 1개
  await chat(B, '@claude b0 만들어줘');
  const p1 = await waitParts(1);
  assert.equal(p1[0].prevSnapshot, null);
  assert.equal(fs.readFileSync(path.join(B.wt, 'b0.txt'), 'utf8'), '고친 코드 0');
  await until(() => lastApplied(B) === p1[0].snapshot, 'B 가 올린 스냅샷 기록');
  assert.equal(fs.existsSync(A.wt), false); // A 는 사본이 아직 없다 → 알림이 와도 만들지 않는다
  assert.deepEqual(A.localCode(), []);

  // 2) A 가 실행: 실행 전에 B 의 변경을 받고, 올리는 것은 증분. B 는 알림으로 맞춰진다
  await chat(A, '@claude a0 만들어줘');
  const p2 = await waitParts(2);
  assert.equal(p2[1].prevSnapshot, p1[0].snapshot);
  assert.equal(fs.readFileSync(path.join(A.wt, 'b0.txt'), 'utf8'), '고친 코드 0'); // 실행 전에 맞춰졌다
  assert.equal(fs.readFileSync(path.join(A.wt, 'a0.txt'), 'utf8'), '고친 코드 0');
  await until(() => B.localCode().some((e) => e.repoId === repo.id && e.status === 'ok'), 'B 사본 맞춤 알림');
  assert.equal(fs.readFileSync(path.join(B.wt, 'a0.txt'), 'utf8'), '고친 코드 0');
  assert.equal(lastApplied(B), p2[1].snapshot);
  assert.equal(g(B.src, 'rev-parse', `refs/rooms/${roomId}/${repo.id}`), p2[1].snapshot); // 원본 이름표
  assert.equal(g(B.src, 'branch', '--show-current'), 'main'); // 원본은 그대로
  assert.equal(g(B.src, 'status', '--porcelain'), '');

  // 3) B 가 다시 실행: 이미 맞춰져 있으니 받지 않고, 그 위의 증분을 올린다. A 는 알림으로 맞춰진다
  await chat(B, '@claude b1 만들어줘');
  const p3 = await waitParts(3);
  assert.equal(p3[2].prevSnapshot, p2[1].snapshot);
  await until(() => A.localCode().some((e) => e.status === 'ok'), 'A 사본 맞춤 알림');
  assert.equal(fs.readFileSync(path.join(A.wt, 'b1.txt'), 'utf8'), '고친 코드 1');
  assert.equal(g(A.src, 'rev-parse', `refs/rooms/${roomId}/${repo.id}`), p3[2].snapshot);

  // 4) 레포를 연결하지 않은 C 가 실행: 원본을 자동으로 받고(clone), 사본을 맞춘 뒤 증분을 올린다
  await chat(C, '@claude c0 만들어줘');
  const p4 = await waitParts(4);
  assert.equal(p4[3].prevSnapshot, p3[2].snapshot);
  assert.ok(C.config().rooms[roomId].repos[repo.id].startsWith(path.join(C.home, 'repos')));
  for (const f of ['a0.txt', 'b0.txt', 'b1.txt', 'c0.txt']) assert.ok(fs.existsSync(path.join(C.wt, f)), f);
  await until(() => A.localCode().filter((e) => e.status === 'ok').length >= 2, 'A 가 C 의 변경 맞춤');
  assert.equal(fs.existsSync(path.join(A.wt, 'c0.txt')), true);
  assert.equal(await (async () => (await parts()).length)(), 4);
});

test('다른 사람이 기준을 바꿔 사본이 비워지면: 실행 중인 맥은 끝난 뒤에 새 기준으로 맞춘다', { timeout: 120000 }, async () => {
  const bare = path.join(tmp, 'r2.git');
  const seed = path.join(tmp, 'seed2');
  fs.mkdirSync(seed);
  g(seed, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(seed, 'README.md'), 'r\n');
  g(seed, 'add', '.');
  g(seed, 'commit', '-q', '-m', 'init');
  g(tmp, 'init', '-q', '--bare', '-b', 'main', bare);
  g(seed, 'remote', 'add', 'origin', bare);
  g(seed, 'push', '-q', 'origin', 'main');
  g(seed, 'switch', '-q', '-c', 'dev');
  fs.writeFileSync(path.join(seed, 'dev.txt'), 'd\n');
  g(seed, 'add', '.');
  g(seed, 'commit', '-q', '-m', 'dev');
  g(seed, 'push', '-q', 'origin', 'dev');
  const devTip = g(bare, 'rev-parse', 'dev');
  const serverUrl = `http://localhost:${server.port}`;

  const record = path.join(tmp, 'D-record');
  const A = mac('A2', []);
  const D = mac('D2', ['d0.txt', 'd1.txt'], { FAKE_SLEEP_MS: '3000', FAKE_RECORD: record });
  await A.call('signup', { serverUrl, email: 'a2@x.com', password: 'password1', name: 'a2' });
  await D.call('signup', { serverUrl, email: 'd2@x.com', password: 'password1', name: 'd2' });
  const room = await A.call('createRoom', { name: '기준 변경' });
  await D.call('joinRoom', { inviteCode: room.inviteCode });
  const roomId = room.id;
  const repo = await A.call('addRepo', { roomId, name: 'r', remoteUrl: bare, branch: 'main' });
  const clone = path.join(tmp, 'D2-clone');
  g(tmp, 'clone', '-q', bare, clone);
  await D.call('openRoom', { roomId });
  await D.call('linkRepo', { roomId, repoId: repo.id, localPath: clone });
  const wt = path.join(D.home, String(roomId), 'repos', `${repo.id}-r`);
  const parts = async () => (await (await fetch(`${serverUrl}/rooms/${roomId}/code/${repo.id}`, { headers: { authorization: `Bearer ${A.token()}` } })).json()).parts;

  await D.call('sendMessage', { roomId, text: '@claude 첫 실행' });
  await until(async () => (await parts()).length === 1, '첫 조각');
  assert.equal(fs.readFileSync(path.join(wt, 'd0.txt'), 'utf8'), '고친 코드 0');
  fs.rmSync(record, { force: true });

  // 두 번째 실행이 도는 동안 방장이 기준 브랜치를 바꾼다(서버가 코드 상태를 비우고 CODE_CHANGED 를 알린다)
  await D.call('sendMessage', { roomId, text: '@claude 두 번째 실행' });
  await until(() => fs.existsSync(record), 'D 의 claude 시작');
  await A.call('updateRepo', { repoId: repo.id, branch: 'dev' });
  await until(async () => (await parts()).length === 0, '서버가 코드 상태를 비움');
  await sleep(800);
  assert.deepEqual(D.localCode(), []); // 실행 중이라 아직 맞추지 않았다
  assert.notEqual(g(wt, 'rev-parse', 'HEAD'), devTip);

  // 실행이 끝나면 새 기준(dev)으로 맞춘다
  const ev = await until(() => D.localCode()[0], '끝난 뒤 맞춤 알림');
  assert.deepEqual([ev.roomId, ev.repoId, ev.status], [roomId, repo.id, 'ok']);
  assert.equal(g(wt, 'rev-parse', 'HEAD'), devTip);
  assert.equal(g(wt, 'status', '--porcelain'), '');
  assert.equal(D.config().rooms[roomId]?.code?.[repo.id], undefined); // 서버가 비웠으니 맞춰 둔 스냅샷 기록도 없다
});
