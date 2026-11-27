import { execFileSync } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDb } from './db.js';
import { createFileStore } from './files.js';
import { createHttpHandler } from './http.js';
import { attachWs } from './ws.js';

const srcRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// 소스 폴더의 HEAD 짧은 해시. git 이 아니면 null
function gitHead() {
  try {
    return execFileSync('git', ['-C', srcRoot, 'rev-parse', '--short', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null;
  } catch { return null; }
}

/**
 * 서버 시작. port 0 이면 빈 포트. commit 을 주지 않으면 소스 폴더의 git HEAD
 * @param {{port?: number, dataDir: string, commit?: string|null}} opts
 * @returns {Promise<{port: number, running: () => number, close: () => Promise<void>}>}
 */
export async function startServer({ port = 4310, dataDir, commit }) {
  const db = openDb(path.join(dataDir, 'rooms.db'));
  const files = createFileStore(dataDir);
  const server = http.createServer(createHttpHandler({ db, files, commit: commit === undefined ? gitHead() : commit }));
  const ws = attachWs(server, { db, files });
  ws.queue.recoverOnStart();
  const timer = setInterval(() => ws.queue.tick(), 5000);
  timer.unref();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, resolve);
  });
  return {
    port: server.address().port,
    // 실행 중인 Claude 요청 수(관리 프로그램이 재시작 시점을 잡을 때 쓴다)
    running: () => db.prepare("SELECT COUNT(*) AS c FROM messages WHERE kind = 'claude_request' AND status = 'running'").get().c,
    async close() {
      clearInterval(timer);
      ws.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dataDir = process.env.DATA_DIR
    ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
  const srv = await startServer({ port: Number(process.env.PORT ?? 4310), dataDir });
  const { port } = srv;
  // 관리 프로그램(supervisor)이 띄웠으면 실행 중인 요청 수를 물어 올 때 답한다
  if (process.send) {
    process.on('message', (m) => { if (m?.type === 'busy?') process.send({ type: 'busy', running: srv.running() }); });
  }
  console.log(`서버 시작: http://localhost:${port} (데이터 ${dataDir})`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`  LAN: http://${a.address}:${port}`);
    }
  }
}
