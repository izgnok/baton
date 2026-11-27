import './stdoutGuard.js';
import { fixPath } from './env.js';
import { createService, smoke } from './service.js';
import { createStdioServer } from './stdio.js';

await fixPath();

if (process.argv.includes('--smoke')) {
  const timer = setTimeout(() => { process.stdout.write(`${JSON.stringify({ ok: false, error: 'SMOKE_TIMEOUT' })}\n`, () => process.exit(1)); }, 60000);
  const result = await smoke().catch((e) => ({ ok: false, error: e.message }));
  clearTimeout(timer);
  process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(result.ok ? 0 : 1));
} else {
  let server;
  const service = createService({ emit: (event, payload) => server.emit(event, payload), relaunch: () => server.emit('relaunch', null) });
  server = createStdioServer({
    input: process.stdin,
    output: process.stdout,
    handlers: service.handlers,
    onEnd: () => { service.stop(); process.exit(0); },
  });
  await service.start({ capture: !!process.env.ROOMS_SCREENSHOT });
}
