import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const MCP_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'approveMcp.js');

// 방 도구 이름(approveMcp.js 의 registerTool 이름과 같다)
export const ROOM_TOOLS = ['room_repos', 'local_repos', 'room_set_repo', 'room_remove_repo', 'room_open_folder', 'room_relink', 'room_reclone'];
// 승인 없이 허용할 읽기 전용 방 도구(allowedTools 에 넣는 이름)
export const ROOM_READ_TOOLS = ['mcp__rooms__room_repos', 'mcp__rooms__local_repos', 'mcp__rooms__room_open_folder'];

/**
 * 승인 다리: claude 의 MCP 서버가 로컬 HTTP 로 물어 오면 askUser 로 전달한다
 * @param {{askUser: (q: {toolName: string, input: unknown, toolUseId?: string}) => Promise<'allow'|'deny'>,
 *   timeoutMs?: number, readRepos?: string[],
 *   onTool?: (name: string, input: object) => Promise<string>}} opts
 * @returns {Promise<{port: number, mcpConfigPath: string, close: () => Promise<void>}>}
 */
export async function startApprovalBridge({ askUser, timeoutMs = 600000, readRepos = [], onTool }) {
  const secret = randomBytes(32).toString('hex');

  async function decide(q) {
    let timer;
    try {
      const answer = await Promise.race([
        askUser(q),
        new Promise((resolve) => { timer = setTimeout(() => resolve('deny'), timeoutMs); }),
      ]);
      return answer === 'allow' ? 'allow' : 'deny';
    } catch {
      return 'deny';
    } finally {
      clearTimeout(timer);
    }
  }

  const server = http.createServer((req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST' || (req.url !== '/approve' && req.url !== '/tool')) return reply(404, { error: 'NOT_FOUND' });
    if (req.headers['x-rooms-secret'] !== secret) return reply(403, { error: 'FORBIDDEN' });
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      let q;
      try { q = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reply(400, { error: 'INVALID_INPUT' }); }
      if (req.url === '/tool') {
        if (!ROOM_TOOLS.includes(q?.name)) return reply(200, { ok: false, error: 'UNKNOWN_TOOL' });
        if (!onTool) return reply(200, { ok: false, error: '이 실행에서는 방 도구를 쓸 수 없어요' });
        try {
          return reply(200, { ok: true, text: await onTool(q.name, q.input ?? {}) });
        } catch (e) {
          return reply(200, { ok: false, error: e?.message ?? String(e) });
        }
      }
      reply(200, { decision: await decide({ toolName: q.toolName, input: q.input, toolUseId: q.toolUseId }) });
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-approve-'));
  const mcpConfigPath = path.join(dir, 'mcp.json');
  fs.writeFileSync(mcpConfigPath, JSON.stringify({
    mcpServers: {
      rooms: {
        command: process.execPath,
        args: [MCP_SCRIPT],
        env: {
          ELECTRON_RUN_AS_NODE: '1', ROOMS_APPROVE_PORT: String(port), ROOMS_APPROVE_SECRET: secret,
          ROOMS_READ_REPOS: JSON.stringify(readRepos), // git_read 가 읽을 수 있는 저장소
        },
      },
    },
  }), { mode: 0o600 });
  fs.chmodSync(mcpConfigPath, 0o600);

  return {
    port,
    mcpConfigPath,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
