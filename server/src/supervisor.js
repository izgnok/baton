// 서버 관리 프로그램: index.js 를 자식으로 띄우고, 죽으면 다시 띄우고, 새 커밋이 있으면 따라가 재시작한다
import { fork as nodeFork } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as src from '@rooms/shared/sourceUpdate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{script?: string, root?: string, intervalMs?: number, busyPollMs?: number, killGraceMs?: number,
 *   restartDelayMs?: number, install?: (root: string) => Promise<any>, log?: {log: Function, warn: Function, error: Function}}} [o]
 * @returns {{checkNow: () => Promise<string>, stop: () => Promise<void>, pid: () => number|undefined, halted: () => boolean}}
 */
export function startSupervisor({
  script = path.join(here, 'index.js'), root = path.join(here, '..', '..'),
  intervalMs = 30 * 60 * 1000, busyPollMs = 10000, killGraceMs = 5000, restartDelayMs = 2000,
  install = src.npmInstall, log = console,
} = {}) {
  let child = null;
  let childHead = null; // 자식을 띄울 때의 소스 HEAD
  let stopping = false; // 일부러 종료하는 중(재시작·관리 프로그램 종료): 자동 재시작하지 않는다
  let halted = false;
  let checking = false;
  let crashes = [];
  let crashTimer = null;

  async function spawnChild() {
    childHead = await src.sourceHead(root);
    const c = nodeFork(script, [], { env: process.env });
    child = c;
    log.log(`서버 시작 (pid ${c.pid}${childHead ? `, ${childHead.slice(0, 7)}` : ''})`);
    c.on('exit', (code, sig) => {
      if (child === c) child = null;
      if (stopping) return;
      const now = Date.now();
      crashes = [...crashes.filter((t) => now - t < 60000), now];
      if (crashes.length > 5) {
        halted = true;
        log.error('서버가 1분 안에 5번 넘게 종료돼 멈춥니다. 로그를 확인하고 직접 다시 시작해 주세요');
        return;
      }
      log.warn(`서버가 종료됐어요(${sig ?? code}). ${restartDelayMs / 1000}초 뒤 다시 시작합니다`);
      crashTimer = setTimeout(() => { crashTimer = null; if (!stopping) spawnChild(); }, restartDelayMs);
    });
  }

  // 자식에게 실행 중 요청 수를 묻는다. 답이 없으면 바쁜 것으로 본다
  function runningCount() {
    const c = child;
    if (!c) return Promise.resolve(0);
    return new Promise((resolve) => {
      const onMsg = (m) => { if (m?.type === 'busy') { clearTimeout(t); c.off('message', onMsg); resolve(Number(m.running)); } };
      const t = setTimeout(() => { c.off('message', onMsg); resolve(Infinity); }, 5000);
      c.on('message', onMsg);
      c.send({ type: 'busy?' }, (err) => { if (err) { clearTimeout(t); c.off('message', onMsg); resolve(0); } });
    });
  }

  async function waitIdle() {
    for (;;) {
      if (stopping || await runningCount() === 0) return;
      await sleep(busyPollMs);
    }
  }

  async function killChild() {
    const c = child;
    if (!c || c.exitCode !== null || c.signalCode) return;
    await new Promise((resolve) => {
      c.once('exit', resolve);
      c.kill('SIGTERM');
      setTimeout(() => c.kill('SIGKILL'), killGraceMs).unref();
    });
  }

  async function restart() {
    stopping = true;
    try { await killChild(); } finally { stopping = false; }
    await spawnChild();
  }

  /** 새 커밋 확인 → 필요하면 따라가 재시작. 한 일을 문자열로 돌려준다 */
  async function checkNow() {
    if (checking || stopping || halted) return 'busy';
    checking = true;
    try {
      const head = await src.sourceHead(root);
      if (!head) return 'not-git';
      let behind;
      try { ({ count: behind } = await src.fetchBehind(root)); } catch (e) { log.warn(`원격 확인 실패: ${e.message}`); return 'fetch-failed'; }
      if (!behind && head === childHead) return 'up-to-date';
      await waitIdle();
      if (behind) {
        if (await src.isDirty(root)) { log.warn('소스에 커밋 안 된 변경이 있어 업데이트를 건너뜁니다'); return 'dirty'; }
        const { lockChanged } = await src.pullFf(root);
        if (lockChanged) await install(root);
      }
      await waitIdle(); // 받는 동안 새로 시작한 요청이 끝날 때까지
      log.log('새 버전으로 서버를 다시 시작합니다');
      await restart();
      return 'restarted';
    } catch (e) {
      log.error(`업데이트 실패: ${e.message}`);
      return 'failed';
    } finally {
      checking = false;
    }
  }

  const timer = setInterval(() => { checkNow(); }, intervalMs);
  timer.unref();
  spawnChild();

  return {
    checkNow,
    pid: () => child?.pid,
    halted: () => halted,
    async stop() {
      stopping = true;
      clearInterval(timer);
      clearTimeout(crashTimer);
      await killChild();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sup = startSupervisor({ intervalMs: Number(process.env.SUPERVISOR_INTERVAL_MS) || undefined });
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => sup.stop().then(() => process.exit(0)));
}
