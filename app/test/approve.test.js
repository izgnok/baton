import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startApprovalBridge, ROOM_TOOLS } from '../main/runner/approve.js';

// 설정 파일의 command/args/env 그대로 approveMcp 에 붙어 approve 를 한 번 호출한다
async function callApprove(mcpConfigPath, args) {
  const { command, args: cmdArgs, env } = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8')).mcpServers.rooms;
  const client = new Client({ name: 'test', version: '0' });
  const transport = new StdioClientTransport({ command, args: cmdArgs, env: { ...process.env, ...env } });
  await client.connect(transport);
  try {
    const r = await client.callTool({ name: 'approve', arguments: args });
    return JSON.parse(r.content[0].text);
  } finally {
    await client.close();
  }
}

const call = { tool_name: 'Bash', input: { command: 'ls 한글' }, tool_use_id: 'tu_1' };

test('allow: updatedInput 은 받은 input 그대로, askUser 는 정리된 값을 받는다', async () => {
  const asked = [];
  const bridge = await startApprovalBridge({ askUser: async (q) => (asked.push(q), 'allow') });
  try {
    assert.deepEqual(await callApprove(bridge.mcpConfigPath, call), { behavior: 'allow', updatedInput: call.input });
    assert.deepEqual(asked, [{ toolName: 'Bash', input: call.input, toolUseId: 'tu_1' }]);
  } finally { await bridge.close(); }
});

test('deny, askUser throw, 시간 초과는 모두 deny', async () => {
  const modes = { deny: async () => 'deny', throws: async () => { throw new Error('x'); }, hang: () => new Promise(() => {}) };
  for (const [name, askUser] of Object.entries(modes)) {
    const bridge = await startApprovalBridge({ askUser, timeoutMs: 50 });
    try {
      assert.deepEqual(await callApprove(bridge.mcpConfigPath, call), { behavior: 'deny', message: '사용자가 거부했습니다' }, name);
    } finally { await bridge.close(); }
  }
});

test('비밀값 없는 POST 는 403, GET 과 다른 경로는 404', async () => {
  const bridge = await startApprovalBridge({ askUser: async () => 'allow' });
  try {
    const url = `http://127.0.0.1:${bridge.port}/approve`;
    assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 403);
    assert.equal((await fetch(url, { method: 'POST', body: '{}', headers: { 'x-rooms-secret': 'wrong' } })).status, 403);
    assert.equal((await fetch(url)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${bridge.port}/other`, { method: 'POST' })).status, 404);
  } finally { await bridge.close(); }
});

test('mcp.json 은 600, close 후 임시 폴더와 포트가 없어진다', async () => {
  const bridge = await startApprovalBridge({ askUser: async () => 'allow' });
  const dir = path.dirname(bridge.mcpConfigPath);
  assert.equal(fs.statSync(bridge.mcpConfigPath).mode & 0o777, 0o600);
  const cfg = JSON.parse(fs.readFileSync(bridge.mcpConfigPath, 'utf8')).mcpServers.rooms;
  assert.equal(cfg.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(cfg.env.ROOMS_APPROVE_PORT, String(bridge.port));
  assert.ok(fs.existsSync(cfg.args[0]));
  await bridge.close();
  assert.equal(fs.existsSync(dir), false);
  await assert.rejects(fetch(`http://127.0.0.1:${bridge.port}/approve`, { method: 'POST' }));
});

test('다리가 닫힌 뒤에는 연결 실패 메시지로 deny', async () => {
  const bridge = await startApprovalBridge({ askUser: async () => 'allow' });
  const saved = fs.readFileSync(bridge.mcpConfigPath); // close 가 지우기 전에 설정을 복사
  await bridge.close();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-approve-test-'));
  const file = path.join(dir, 'mcp.json');
  fs.writeFileSync(file, saved);
  try {
    assert.deepEqual(await callApprove(file, call), { behavior: 'deny', message: '승인 창에 연결하지 못했습니다' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- 방 도구(/tool) ----
function secretOf(bridge) {
  return JSON.parse(fs.readFileSync(bridge.mcpConfigPath, 'utf8')).mcpServers.rooms.env.ROOMS_APPROVE_SECRET;
}
async function tool(bridge, body) {
  const r = await fetch(`http://127.0.0.1:${bridge.port}/tool`, {
    method: 'POST', body: JSON.stringify(body), headers: { 'x-rooms-secret': secretOf(bridge) },
  });
  return { status: r.status, json: await r.json() };
}

test('/tool: 비밀값 없으면 403', async () => {
  const bridge = await startApprovalBridge({ askUser: async () => 'allow', onTool: async () => 'x' });
  try {
    const url = `http://127.0.0.1:${bridge.port}/tool`;
    assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 403);
    assert.equal((await fetch(url, { method: 'POST', body: '{}', headers: { 'x-rooms-secret': 'wrong' } })).status, 403);
  } finally { await bridge.close(); }
});

test('/tool: onTool 결과·throw·미지정·모르는 이름', async () => {
  const seen = [];
  const bridge = await startApprovalBridge({
    askUser: async () => 'allow',
    onTool: async (name, input) => { seen.push([name, input]); if (input.boom) throw new Error('실패했어요'); return '결과 본문'; },
  });
  try {
    assert.deepEqual((await tool(bridge, { name: 'room_repos', input: { a: 1 } })).json, { ok: true, text: '결과 본문' });
    assert.deepEqual(seen, [['room_repos', { a: 1 }]]);
    assert.deepEqual((await tool(bridge, { name: 'room_repos', input: { boom: 1 } })).json, { ok: false, error: '실패했어요' });
    assert.deepEqual((await tool(bridge, { name: 'rm_rf', input: {} })).json, { ok: false, error: 'UNKNOWN_TOOL' });
  } finally { await bridge.close(); }
  const bare = await startApprovalBridge({ askUser: async () => 'allow' });
  try {
    assert.deepEqual((await tool(bare, { name: 'room_repos', input: {} })).json, { ok: false, error: '이 실행에서는 방 도구를 쓸 수 없어요' });
  } finally { await bare.close(); }
});

test('MCP: 방 도구 7개가 보이고 호출이 onTool 에 그대로 닿는다', async () => {
  const seen = [];
  const bridge = await startApprovalBridge({
    askUser: async () => 'allow',
    onTool: async (name, input) => { seen.push([name, input]); if (input.repoId === 9) throw new Error('없는 레포'); return `${name} 완료`; },
  });
  const { command, args, env } = JSON.parse(fs.readFileSync(bridge.mcpConfigPath, 'utf8')).mcpServers.rooms;
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StdioClientTransport({ command, args, env: { ...process.env, ...env } }));
  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ROOM_TOOLS) assert.ok(names.includes(n), n);
    assert.equal(ROOM_TOOLS.length, 7);
    const input = { remoteUrl: 'git@x.com:a/b.git', baseBranch: 'main' };
    const ok = await client.callTool({ name: 'room_set_repo', arguments: input });
    assert.deepEqual(seen, [['room_set_repo', input]]);
    assert.equal(ok.isError, undefined);
    assert.equal(ok.content[0].text, 'room_set_repo 완료');
    const bad = await client.callTool({ name: 'room_remove_repo', arguments: { repoId: 9 } });
    assert.equal(bad.isError, true);
    assert.equal(bad.content[0].text, '없는 레포');
  } finally { await client.close(); await bridge.close(); }
});
