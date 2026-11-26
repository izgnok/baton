// claude 가 띄우는 stdio MCP 서버. stdout 에는 MCP 메시지만 쓴다(로그는 stderr)
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const port = process.env.ROOMS_APPROVE_PORT;
const secret = process.env.ROOMS_APPROVE_SECRET ?? '';

const deny = (message) => ({ behavior: 'deny', message });

async function decide({ tool_name: toolName, input, tool_use_id: toolUseId }) {
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rooms-secret': secret },
      body: JSON.stringify({ toolName, input, toolUseId }),
    });
  } catch (e) {
    console.error('승인 창 연결 실패:', e.message);
    return deny('승인 창에 연결하지 못했습니다');
  }
  const body = res.ok ? await res.json().catch(() => null) : null;
  if (body?.decision === 'allow') return { behavior: 'allow', updatedInput: input };
  return deny(body?.decision === 'deny' ? '사용자가 거부했습니다' : '승인 창에 연결하지 못했습니다');
}

const server = new McpServer({ name: 'rooms', version: '0.1.0' });
server.registerTool(
  'approve',
  {
    description: 'Permission prompt',
    inputSchema: { tool_name: z.string(), input: z.any(), tool_use_id: z.string().optional() },
  },
  async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await decide(args)) }] }),
);
await server.connect(new StdioServerTransport());
