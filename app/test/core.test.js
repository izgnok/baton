import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 코어를 띄워 한 줄 JSON 으로 주고받는다. 바깥을 건드리는 백그라운드 작업은 끈다
function startCore(home, args = []) {
  const child = spawn(process.execPath, ['main/core.js', ...args], {
    cwd: appDir,
    env: { ...process.env, ROOMS_HOME: home, ROOMS_NO_BACKGROUND: '1' },
  });
  const raw = [];
  const lines = [];
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    const parts = buf.split('\n');
    buf = parts.pop();
    for (const l of parts) { raw.push(l); try { lines.push(JSON.parse(l)); } catch { /* raw 로 검사 */ } }
  });
  child.stderr.on('data', () => {});
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  let id = 0;
  const call = (name, args = {}) => {
    const mine = ++id;
    child.stdin.write(`${JSON.stringify({ id: mine, call: name, args })}\n`);
    return new Promise((resolve, reject) => {
      const t = setInterval(() => {
        const m = lines.find((x) => x.id === mine);
        if (m) { clearInterval(t); resolve(m); }
      }, 10);
      setTimeout(() => { clearInterval(t); reject(new Error(`응답 없음: ${name}`)); }, 10000).unref();
    });
  };
  return { child, call, raw, exited };
}

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-core-'));

test('core: getConfig 응답 — 새 홈이면 loggedIn false, hostServer false', async () => {
  const c = startCore(tmpHome());
  try {
    const r = await c.call('getConfig');
    assert.equal(r.ok, true);
    assert.equal(r.data.loggedIn, false);
    assert.equal(r.data.hostServer, false);
  } finally { c.child.kill(); }
});

test('core: setHostServer 뒤 getConfig.hostServer true, config.json 에 저장', async () => {
  const home = tmpHome();
  const c = startCore(home);
  try {
    assert.deepEqual((await c.call('setHostServer', { on: true })).data, { hostServer: true });
    assert.equal((await c.call('getConfig')).data.hostServer, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).hostServer, true);
  } finally { c.child.kill(); }
  // 다시 띄워도 유지
  const c2 = startCore(home);
  try {
    assert.equal((await c2.call('getConfig')).data.hostServer, true);
  } finally { c2.child.kill(); }
});

test('core: 처리기 안의 console.log 가 stdout 을 깨지 않는다', async () => {
  const c = startCore(tmpHome());
  try {
    // 코어가 거치는 모듈들이 console.log 를 해도 stdout 은 응답 줄뿐이어야 한다
    await c.call('getConfig');
    assert.equal((await c.call('nope')).error, 'UNKNOWN_CALL');
    assert.ok(c.raw.length >= 2);
    for (const l of c.raw) assert.doesNotThrow(() => JSON.parse(l), `JSON 이 아닌 줄: ${l}`);
    // console.log 를 직접 불러도 stdout 이 비어 있다(stderr 로 간다)
    const r = spawnSync(process.execPath, ['-e', "import('./main/stdoutGuard.js').then(() => console.log('x'))"], { cwd: appDir, encoding: 'utf8' });
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, 'x\n');
  } finally { c.child.kill(); }
});

test('core: stdin 을 닫으면 3초 안에 종료(코드 0)', async () => {
  const c = startCore(tmpHome());
  await c.call('getConfig');
  c.child.stdin.end();
  const code = await Promise.race([c.exited, new Promise((r) => setTimeout(() => r('timeout'), 3000))]);
  if (code === 'timeout') c.child.kill();
  assert.equal(code, 0);
});

test('core: --smoke 가 ok:true 를 낸다', { timeout: 90000 }, async () => {
  const c = startCore(tmpHome(), ['--smoke']);
  const code = await c.exited;
  const last = JSON.parse(c.raw.at(-1));
  assert.equal(last.ok, true, JSON.stringify(last));
  assert.equal(last.server.ok, true);
  assert.equal(last.connect.ok, true);
  assert.equal(code, 0);
});
