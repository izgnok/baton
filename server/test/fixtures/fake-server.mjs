// 관리 프로그램 테스트용 가짜 서버: 시작 기록을 남기고 busy? 에 파일 값으로 답한다
import fs from 'node:fs';

fs.appendFileSync(process.env.START_LOG, `${process.pid}\n`);
if (process.env.EXIT_AT_START) process.exit(1);
process.on('message', (m) => {
  if (m?.type !== 'busy?') return;
  const running = Number(fs.readFileSync(process.env.BUSY_FILE, 'utf8').trim() || 0);
  process.send({ type: 'busy', running });
});
setInterval(() => {}, 1000);
