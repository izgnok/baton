import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { gitRead, loadAllowedRepos } from '../main/runner/gitRead.js';
import { startApprovalBridge } from '../main/runner/approve.js';

const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString().trim();

let tmp;
let bare;
let repo; // 허용된 내 레포(clone)
let other; // 허용 목록에 없는 레포
let seed;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-gitread-'));
  bare = path.join(tmp, 'r.git');
  seed = path.join(tmp, 'seed');
  fs.mkdirSync(seed);
  g(seed, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(seed, 'a.txt'), 'hello\n');
  fs.writeFileSync(path.join(seed, 'big.txt'), 'x'.repeat(300 * 1024));
  g(seed, 'add', '.');
  g(seed, 'commit', '-q', '-m', 'init');
  g(tmp, 'init', '-q', '--bare', '-b', 'main', bare);
  g(seed, 'remote', 'add', 'origin', bare);
  g(seed, 'push', '-q', 'origin', 'main');
  repo = path.join(tmp, 'repo');
  g(tmp, 'clone', '-q', bare, repo);
  other = path.join(tmp, 'other');
  g(tmp, 'clone', '-q', bare, other);
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const read = (args, r = repo, allowed = [repo]) => gitRead({ repo: r, args, allowed });
const rejects = (args, re, r, allowed) => assert.rejects(read(args, r, allowed), re);

test('허용 저장소의 show·ls-tree·log·diff·rev-parse·branch·cat-file·grep', async () => {
  assert.equal(await read(['show', 'HEAD:a.txt']), 'hello\n');
  assert.match(await read(['ls-tree', '--name-only', 'HEAD']), /a\.txt/);
  assert.match(await read(['log', '--format=%s', '-1']), /init/);
  assert.equal(await read(['diff']), '');
  assert.match(await read(['rev-parse', 'HEAD']), /^[0-9a-f]{40}\n$/);
  assert.match(await read(['branch', '-a']), /main/);
  assert.match(await read(['branch', '-r', '--list', 'origin/m*']), /origin\/main/);
  assert.equal(await read(['cat-file', '-t', 'HEAD']), 'commit\n');
  assert.match(await read(['grep', '-n', 'hello', 'HEAD']), /a\.txt:1:hello/);
  assert.equal(await read(['grep', 'zzzz-no-match', 'HEAD']), ''); // 결과 없음은 오류가 아니다
});

test('출력은 앞 200KB 만', async () => {
  const out = await read(['show', 'HEAD:big.txt']);
  assert.equal(out.length, 200 * 1024);
});

test('허용 목록에 없는 경로·하위 경로는 거부, 같은 폴더를 가리키는 링크는 허용', async () => {
  await rejects(['show', 'HEAD:a.txt'], /허용되지 않은 저장소/, other);
  fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
  await rejects(['show', 'HEAD:a.txt'], /허용되지 않은 저장소/, path.join(repo, 'sub'));
  await rejects(['show', 'HEAD:a.txt'], /허용되지 않은 저장소/, path.join(tmp, 'nope'));
  await rejects(['show', 'HEAD:a.txt'], /허용되지 않은 저장소/, repo, []);
  const link = path.join(tmp, 'link');
  fs.symlinkSync(repo, link);
  assert.equal(await read(['show', 'HEAD:a.txt'], link), 'hello\n');
  await assert.rejects(gitRead({ repo, args: 'show', allowed: [repo] }), /args/);
  await assert.rejects(gitRead({ repo, args: [], allowed: [repo] }), /args/);
});

test('쓰기·이동 명령은 거부', async () => {
  for (const args of [['push', 'origin', 'main'], ['checkout', 'main'], ['switch', 'main'], ['reset', '--hard'],
    ['commit', '-m', 'x'], ['config', 'user.name', 'x'], ['clean', '-fd'], ['worktree', 'list'], ['-c', 'x=y', 'show']]) {
    await rejects(args, /허용되지 않/);
  }
  await rejects(['branch', 'newbranch'], /branch 는/);
  await rejects(['branch', '-D', 'main'], /branch 는/);
  await rejects(['branch', '-r', 'origin/x'], /branch 는/); // 패턴은 --list 와 함께만
  await rejects(['cat-file', '--batch'], /cat-file 은/);
  await rejects(['cat-file', '-p'], /cat-file 은/);
  await rejects(['cat-file', '-e', 'HEAD'], /cat-file 은/);
});

test('위험한 옵션은 줄여 쓴 형태까지 거부하고, 파일은 만들어지지 않는다', async () => {
  const out = path.join(tmp, 'leak.txt');
  for (const a of [`--output=${out}`, `--out=${out}`, '--output', '--exec=x', '--upload-pack=x', '--receive-pack=x',
    '-c', '-cfoo=bar', '--config', '--git-dir=/x', '--work-tree=/x', '--ext-diff', '--textconv', '--no-index',
    '--open-files-in-pager', '-Ocat', '-nOcat', '-iOcat']) {
    await rejects(['log', a], /허용되지 않는 옵션/);
  }
  await rejects(['diff', '--no-index', '/etc/hosts', '/dev/null'], /허용되지 않는 옵션/);
  await rejects(['grep', '-Osh', 'x'], /허용되지 않는 옵션/);
  assert.equal(fs.existsSync(out), false);
  assert.match(await read(['log', '--format=%s', '--no-color', '-1']), /init/); // 평범한 옵션은 통과
});

test('fetch 는 `fetch origin <브랜치>` 만, 받은 뒤 origin/<브랜치> 로 읽는다', async () => {
  for (const args of [['fetch'], ['fetch', 'origin'], ['fetch', 'origin', 'a', 'b'], ['fetch', '--all'],
    ['fetch', bare, 'main'], ['fetch', 'origin', '--upload-pack=x'], ['fetch', 'origin', '-x'], ['fetch', 'origin', 'a..b'],
    ['fetch', 'origin', 'refs/heads/x:refs/heads/y'], ['fetch', 'origin', 'x:y']]) {
    await rejects(args, /fetch 는|브랜치 이름|허용되지 않는 옵션/);
  }
  g(seed, 'checkout', '-q', '-b', 'feature/ABC-1');
  fs.writeFileSync(path.join(seed, 'f.txt'), 'feature\n');
  g(seed, 'add', '.');
  g(seed, 'commit', '-q', '-m', 'feat');
  g(seed, 'push', '-q', 'origin', 'feature/ABC-1');
  await read(['fetch', 'origin', 'feature/ABC-1']);
  assert.equal(await read(['show', 'origin/feature/ABC-1:f.txt']), 'feature\n');
  assert.match(await read(['log', '--format=%s', 'origin/feature/ABC-1', '-1']), /feat/);
  assert.match(await read(['diff', '--stat', 'HEAD...origin/feature/ABC-1']), /f\.txt/);
  assert.equal(g(repo, 'branch', '--show-current'), 'main'); // 체크아웃은 바뀌지 않는다
  await assert.rejects(read(['fetch', 'origin', 'no-such-branch']), /couldn't find remote ref|not found/i);
});

test('loadAllowedRepos: JSON 문자열, 파일 경로, 잘못된 값', () => {
  assert.deepEqual(loadAllowedRepos('["/a","/b"]'), ['/a', '/b']);
  const f = path.join(tmp, 'allowed.json');
  fs.writeFileSync(f, '["/c", 3]');
  assert.deepEqual(loadAllowedRepos(f), ['/c']);
  assert.deepEqual(loadAllowedRepos('{"a":1}'), []);
  assert.deepEqual(loadAllowedRepos(path.join(tmp, 'none.json')), []);
  assert.deepEqual(loadAllowedRepos(undefined), []);
});

test('MCP: 승인 다리가 만든 설정으로 git_read 호출(허용은 성공, 그 밖은 isError)', async () => {
  const bridge = await startApprovalBridge({ askUser: async () => 'deny', readRepos: [repo] });
  const { command, args, env } = JSON.parse(fs.readFileSync(bridge.mcpConfigPath, 'utf8')).mcpServers.rooms;
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StdioClientTransport({ command, args, env: { ...process.env, ...env } }));
  try {
    assert.ok((await client.listTools()).tools.some((t) => t.name === 'git_read'));
    const ok = await client.callTool({ name: 'git_read', arguments: { repo, args: ['show', 'HEAD:a.txt'] } });
    assert.deepEqual([ok.isError ?? false, ok.content[0].text], [false, 'hello\n']);
    const no = await client.callTool({ name: 'git_read', arguments: { repo: other, args: ['show', 'HEAD:a.txt'] } });
    assert.equal(no.isError, true);
    assert.match(no.content[0].text, /허용되지 않은 저장소/);
    const push = await client.callTool({ name: 'git_read', arguments: { repo, args: ['push'] } });
    assert.equal(push.isError, true);
  } finally {
    await client.close();
    await bridge.close();
  }
});
