import './stdoutGuard.js';
import { fixPath } from './env.js';
import { createService, smoke } from './service.js';
import { createStdioServer } from './stdio.js';
import { startCapture } from './capture.js';
import { batonHome } from './localConfig.js';
import { migrateHome } from './migrateHome.js';
import os from 'node:os';
import path from 'node:path';

await fixPath();

if (process.argv.includes('--smoke')) {
  const timer = setTimeout(() => { process.stdout.write(`${JSON.stringify({ ok: false, error: 'SMOKE_TIMEOUT' })}\n`, () => process.exit(1)); }, 60000);
  const result = await smoke().catch((e) => ({ ok: false, error: e.message }));
  clearTimeout(timer);
  process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(result.ok ? 0 : 1));
} else {
  // 캡처 모드는 설정을 읽기 전에 임시 BATON_HOME 을 잡아야 한다
  const cap = process.env.BATON_SCREENSHOT ? await startCapture(process.env.BATON_SCREENSHOT) : null;
  // 옛 데이터 폴더(~/.claude-rooms)를 새 폴더로 옮긴다. service 가 설정을 읽기 전에 끝나야 한다(BATON_HOME 을 준 실행은 건너뜀)
  if (!process.env.BATON_HOME) {
    const oldHome = path.join(os.homedir(), '.claude-rooms');
    const r = await migrateHome({ home: batonHome(), oldHome });
    if (r.moved) process.stderr.write(`데이터 폴더를 ~/.baton 으로 옮겼어요(작업 폴더 ${r.repaired}개 경로 보정)\n`);
    else if (r.reason === 'OLD_RUNNING' || r.reason === 'FAILED') {
      // 이번 실행은 옛 폴더를 그대로 쓴다. 새 폴더에 설정이 따로 생기면 다음 시작 때 옮길 수 없다
      process.env.BATON_HOME = oldHome;
      process.stderr.write(`데이터 폴더를 옮기지 못했어요(${r.reason}) — 이번에는 ~/.claude-rooms 를 쓰고 다음 시작 때 다시 시도해요\n`);
    }
  }
  let server;
  const service = createService({ emit: (event, payload) => server.emit(event, payload), relaunch: () => server.emit('relaunch', null) });
  server = createStdioServer({
    input: process.stdin,
    output: process.stdout,
    handlers: service.handlers,
    onEnd: () => { service.stop(); process.exit(0); },
  });
  await service.start({ capture: !!cap });
  if (cap) {
    // 장면마다 capture:shot 을 알리고 앱이 captureAck 로 답할 때까지 기다린다
    let waiting = null;
    server.setHandler('captureAck', ({ name } = {}) => { if (waiting?.name === name) waiting.resolve(); });
    const shoot = (scene) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CAPTURE_ACK_TIMEOUT: ${scene.name}`)), 60000);
      waiting = { name: scene.name, resolve: () => { clearTimeout(timer); resolve(); } };
      server.emit('capture:shot', scene);
    });
    const done = await cap.run({ handlers: service.handlers, emit: (e, p) => server.emit(e, p), getClient: service.getClient, shoot })
      .then(() => ({ ok: true }), (e) => ({ ok: false, error: String(e?.message ?? e) }));
    server.emit('capture:done', done);
    await cap.cleanup();
  }
}
