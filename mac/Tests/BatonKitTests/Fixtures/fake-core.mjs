// 가짜 코어: 진짜 stdio 서버(app/main/stdio.js)에 테스트용 처리기만 붙인다.
import { createStdioServer } from '../../../../app/main/stdio.js';

const server = createStdioServer({
  input: process.stdin,
  output: process.stdout,
  onEnd: () => process.exit(0),
  handlers: {
    echo: (a) => a,
    fail: () => { throw new Error('NOT_FOUND'); },
    emit: (a) => { server.emit(a.event, a.payload); return null; },
    sleep: (a) => new Promise((r) => setTimeout(() => r(null), a.ms)),
    exit: () => process.exit(3),
    spam: () => { process.stderr.write(`${'x'.repeat(1_200_000)}\n`); return null; },
  },
});
