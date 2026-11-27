import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startSupervisor } from '../src/supervisor.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-server.mjs');
const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString().trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { log() {}, warn() {}, error() {} };

let tmp;
let clone; // 소스 폴더
let pusher; // 원격에 새 커밋을 올리는 다른 클론
let busyFile;
let startLog;
const starts = () => fs.readFileSync(startLog, 'utf8').split('\n').filter(Boolean).length;
const waitFor = async (fn, ms = 4000) => {
  for (let t = 0; t < ms; t += 25) { if (await fn()) return; await sleep(25); }
  throw new Error('대기 시간 초과');
};
const pushCommit = (name) => {
  fs.writeFileSync(path.join(pusher, name), name);
  g(pusher, 'add', '.');
  g(pusher, 'commit', '-q', '-m', `add ${name}`);
  g(pusher, 'push', '-q', 'origin', 'main');
};

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-sup-'));
  const bare = path.join(tmp, 'o.git');
  const seed = path.join(tmp, 'seed');
  fs.mkdirSync(seed);
  g(seed, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(seed, 'package-lock.json'), '{}');
  g(seed, 'add', '.');
  g(seed, 'commit', '-q', '-m', 'init');
  g(tmp, 'init', '-q', '--bare', '-b', 'main', bare);
  g(seed, 'remote', 'add', 'origin', bare);
  g(seed, 'push', '-q', 'origin', 'main');
  clone = path.join(tmp, 'clone');
  pusher = path.join(tmp, 'pusher');
  g(tmp, 'clone', '-q', bare, clone);
  g(tmp, 'clone', '-q', bare, pusher);
  busyFile = path.join(tmp, 'busy');
  startLog = path.join(tmp, 'starts.log');
  fs.writeFileSync(busyFile, '0');
  fs.writeFileSync(startLog, '');
  process.env.BUSY_FILE = busyFile;
  process.env.START_LOG = startLog;
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('새 커밋: 실행 중 요청이 있으면 기다렸다가 pull·재시작, lock 이 바뀌면 install', async () => {
  const installs = [];
  const sup = startSupervisor({
    script: FAKE, root: clone, intervalMs: 3600000, busyPollMs: 50, killGraceMs: 500,
    install: async (r) => installs.push(r), log: quiet,
  });
  try {
    await waitFor(() => starts() === 1);
    assert.equal(await sup.checkNow(), 'up-to-date');
    const pid1 = sup.pid();

    pushCommit('a.txt');
    fs.writeFileSync(path.join(pusher, 'package-lock.json'), '{"x":1}');
    g(pusher, 'commit', '-qam', 'lock');
    g(pusher, 'push', '-q', 'origin', 'main');

    fs.writeFileSync(busyFile, '1');
    const done = sup.checkNow();
    await sleep(300);
    assert.equal(starts(), 1, '실행 중 요청이 있는 동안은 그대로');
    assert.equal(fs.existsSync(path.join(clone, 'a.txt')), false);
    fs.writeFileSync(busyFile, '0');
    assert.equal(await done, 'restarted');
    await waitFor(() => starts() === 2);
    assert.notEqual(sup.pid(), pid1);
    assert.equal(g(clone, 'rev-parse', 'HEAD'), g(pusher, 'rev-parse', 'HEAD'));
    assert.deepEqual(installs, [clone]);
    assert.equal(await sup.checkNow(), 'up-to-date'); // 자식도 새 HEAD 로 떠 있다
  } finally {
    await sup.stop();
  }
});

test('소스에 로컬 수정이 있으면 건너뛴다', async () => {
  const sup = startSupervisor({ script: FAKE, root: clone, intervalMs: 3600000, busyPollMs: 50, killGraceMs: 500, install: async () => {}, log: quiet });
  const before = starts();
  try {
    await waitFor(() => starts() === before + 1);
    pushCommit('b.txt');
    fs.writeFileSync(path.join(clone, 'package-lock.json'), '{"dirty":true}');
    assert.equal(await sup.checkNow(), 'dirty');
    assert.equal(starts(), before + 1);
    assert.equal(fs.existsSync(path.join(clone, 'b.txt')), false);
    g(clone, 'checkout', 'package-lock.json');
    assert.equal(await sup.checkNow(), 'restarted');
    assert.equal(fs.existsSync(path.join(clone, 'b.txt')), true);
  } finally {
    await sup.stop();
  }
});

test('git 최상위가 아니면 업데이트를 하지 않는다', async () => {
  const plain = fs.mkdtempSync(path.join(tmp, 'plain-'));
  const sup = startSupervisor({ script: FAKE, root: plain, intervalMs: 3600000, log: quiet });
  try {
    assert.equal(await sup.checkNow(), 'not-git');
  } finally {
    await sup.stop();
  }
});

test('자식이 계속 죽으면 다시 띄우다가 1분에 5번 넘으면 멈춘다', async () => {
  process.env.EXIT_AT_START = '1';
  const before = starts();
  const sup = startSupervisor({ script: FAKE, root: tmp, intervalMs: 3600000, restartDelayMs: 10, log: quiet });
  try {
    await waitFor(() => sup.halted());
    await sleep(100);
    assert.equal(starts() - before, 6);
  } finally {
    delete process.env.EXIT_AT_START;
    await sup.stop();
  }
});

test('자식이 한 번 죽으면 다시 뜬다', async () => {
  const sup = startSupervisor({ script: FAKE, root: tmp, intervalMs: 3600000, restartDelayMs: 10, killGraceMs: 500, log: quiet });
  const before = starts();
  try {
    await waitFor(() => starts() === before + 1);
    process.kill(sup.pid(), 'SIGKILL');
    await waitFor(() => starts() === before + 2);
    assert.equal(sup.halted(), false);
  } finally {
    await sup.stop();
  }
});
