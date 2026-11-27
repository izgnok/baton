// claude 가 띄우는 stdio MCP 서버. stdout 에는 MCP 메시지만 쓴다(로그는 stderr)
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { gitRead, loadAllowedRepos } from './gitRead.js';

const port = process.env.BATON_APPROVE_PORT;
const secret = process.env.BATON_APPROVE_SECRET ?? '';

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
server.registerTool(
  'git_read',
  {
    description: 'Read-only git on an allowed local repository (fetch origin <branch>, show, grep, ls-tree, log, diff, rev-parse, branch -r/-a/--list, cat-file -p/-t/-s). repo is this PC\'s path of the repository.',
    inputSchema: { repo: z.string(), args: z.array(z.string()) },
  },
  async ({ repo, args }) => {
    try {
      const text = await gitRead({ repo, args, allowed: loadAllowedRepos(process.env.BATON_READ_REPOS) });
      return { content: [{ type: 'text', text: text || '(출력 없음)' }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: e.message }] };
    }
  },
);

// 방 도구: MCP 프로세스는 일하지 않고 앱(다리 /tool)에 넘겨 결과 문구만 돌려준다
async function callRoomTool(name, input) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/tool`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rooms-secret': secret },
      body: JSON.stringify({ name, input }),
    });
    const body = res.ok ? await res.json().catch(() => null) : null;
    if (body?.ok) return { content: [{ type: 'text', text: body.text || '(출력 없음)' }] };
    return { isError: true, content: [{ type: 'text', text: body?.error ?? '앱에 연결하지 못했습니다' }] };
  } catch (e) {
    console.error('방 도구 연결 실패:', e.message);
    return { isError: true, content: [{ type: 'text', text: '앱에 연결하지 못했습니다' }] };
  }
}

const repoId = z.number().int();
const roomTools = {
  room_repos: ['List the room\'s repositories with their base and work branches and a short code-state summary. Use it first when the user talks about the room\'s code or repositories.', {}],
  local_repos: ['List git repositories found on the requesting user\'s Mac (name and remote URL), optionally filtered by a query. Use it to find a repository the user wants to add to the room.', { query: z.string().optional() }],
  room_set_repo: ['Add a repository to the room (omit repoId) or change the base/work branch of an existing one (give repoId). baseBranch must exist on the remote; ask the user which base branch to use only if the room has none for this repo.',
    { repoId: repoId.optional(), remoteUrl: z.string(), name: z.string().optional(), baseBranch: z.string(), workBranch: z.string().optional() }],
  room_remove_repo: ['Remove a repository from the room.', { repoId }],
  room_open_folder: ['Open the room\'s working copy folder of a repository in Finder on the requesting user\'s Mac.', { repoId }],
  room_relink: ['Re-link the original folder of a repository to another path on the requesting user\'s Mac. Use it when the folder was moved or renamed.', { repoId, path: z.string() }],
  room_reclone: ['Delete the working copy of a repository on the requesting user\'s Mac and clone it again. Use it when the copy is broken.', { repoId }],
};
for (const [name, [description, inputSchema]] of Object.entries(roomTools)) {
  server.registerTool(name, { description, inputSchema }, (input) => callRoomTool(name, input));
}
await server.connect(new StdioServerTransport());
