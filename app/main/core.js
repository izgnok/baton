import './stdoutGuard.js';
import { fixPath } from './env.js';
import { createService, smoke } from './service.js';
import { createStdioServer } from './stdio.js';
import { startCapture } from './capture.js';

await fixPath();

if (process.argv.includes('--smoke')) {
  const timer = setTimeout(() => { process.stdout.write(`${JSON.stringify({ ok: false, error: 'SMOKE_TIMEOUT' })}\n`, () => process.exit(1)); }, 60000);
  const result = await smoke().catch((e) => ({ ok: false, error: e.message }));
  clearTimeout(timer);
  process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(result.ok ? 0 : 1));
} else {
  // 캡처 모드는 설정을 읽기 전에 임시 ROOMS_HOME 을 잡아야 한다
  const cap = process.env.ROOMS_SCREENSHOT ? await startCapture(process.env.ROOMS_SCREENSHOT) : null;
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
