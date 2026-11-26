import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDb } from './db.js';
import { createFileStore } from './files.js';
import { createHttpHandler } from './http.js';
import { attachWs } from './ws.js';

/**
 * 서버 시작. port 0 이면 빈 포트
 * @param {{port?: number, dataDir: string}} opts
 * @returns {Promise<{port: number, close: () => Promise<void>}>}
 */
export async function startServer({ port = 4310, dataDir }) {
  const db = openDb(path.join(dataDir, 'rooms.db'));
  const files = createFileStore(dataDir);
  const server = http.createServer(createHttpHandler({ db, files }));
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
  const { port } = await startServer({ port: Number(process.env.PORT ?? 4310), dataDir });
  console.log(`서버 시작: http://localhost:${port} (데이터 ${dataDir})`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`  LAN: http://${a.address}:${port}`);
    }
  }
}
