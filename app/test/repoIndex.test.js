import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { scanRepos, matchRepo, detectReadDirs } from '../main/repoIndex.js';

const g = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();

let home;
const mk = (rel, remote) => {
  const dir = path.join(home, rel);
  fs.mkdirSync(dir, { recursive: true });
  g(dir, 'init', '-q');
  if (remote) g(dir, 'remote', 'add', 'origin', remote);
  return dir;
};
before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-idx-'));
  mk('work/payment-api', 'git@example.com:team/payment-api.git');
  mk('work/team/deep/web'); // origin 없음
  mk('work/lib', 'https://example.com/team/lib');
  mk('solo');
  // 레포 안의 레포는 기록하지 않는다
  mk('work/payment-api/vendor/nested', 'https://example.com/x/nested.git');
  // 건너뛸 폴더와 점 폴더
  mk('Library/Caches/repo');
  mk('node_modules/pkg');
  mk('work/node_modules/pkg');
  mk('.hidden/repo');
  mk('.baton/repos/cloned');
  // .git 이 파일인 레포(워크트리)
  fs.mkdirSync(path.join(home, 'wt'));
  fs.writeFileSync(path.join(home, 'wt/.git'), 'gitdir: /somewhere\n');
  // 깊이 시험: home/a/b/c/d/e/repo(깊이 6), home/a/b/c/d/repo5(깊이 5)
  mk('a/b/c/d/e/too-deep');
  mk('a/b/c/d/ok-depth-5');
  // 심볼릭 링크는 따라가지 않는다
  fs.symlinkSync(path.join(home, 'work/lib'), path.join(home, 'linked'));
  // 홈 자체가 git 레포여도(dotfiles) 그 안을 계속 찾는다
  g(home, 'init', '-q');
});
after(() => fs.rmSync(home, { recursive: true, force: true }));

test('scanRepos: 중첩 폴더의 레포를 찾고, 건너뛸 폴더·점 폴더·링크·레포 안쪽·너무 깊은 곳은 제외', async () => {
  const repos = await scanRepos({ home });
  const rel = repos.map((r) => path.relative(home, r.path));
  assert.deepEqual(rel, ['a/b/c/d/ok-depth-5', 'solo', 'work/lib', 'work/payment-api', 'work/team/deep/web', 'wt']);
  const by = Object.fromEntries(repos.map((r) => [r.name, r]));
  assert.equal(by['payment-api'].remoteUrl, 'git@example.com:team/payment-api.git');
  assert.equal(by.web.remoteUrl, '');
  assert.equal(by.lib.name, 'lib');
});

test('scanRepos: maxDepth 를 따른다', async () => {
  const rel = (await scanRepos({ home, maxDepth: 2 })).map((r) => path.relative(home, r.path));
  assert.deepEqual(rel, ['solo', 'work/lib', 'work/payment-api', 'wt']);
  assert.deepEqual(await scanRepos({ home, maxDepth: 0 }), []);
});

test('matchRepo: 원격 주소 표기가 달라도(ssh/https/.git) 같으면 경로를 돌려준다', async () => {
  const index = { scannedAt: 1, repos: await scanRepos({ home }) };
  assert.equal(matchRepo(index, 'https://example.com/team/payment-api'), path.join(home, 'work/payment-api'));
  assert.equal(matchRepo(index.repos, 'ssh://git@example.com/team/lib.git'), path.join(home, 'work/lib'));
  assert.equal(matchRepo(index, 'https://example.com/team/none'), null);
  assert.equal(matchRepo(index, ''), null); // origin 없는 레포끼리 맞지 않는다
  assert.equal(matchRepo(undefined, 'x'), null);
});

test('detectReadDirs: 위쪽 폴더 중 CLAUDE.md·.claude 가 있는 곳만, 가까운 순, 홈은 뺀다', () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-rd-'));
  try {
    const src = path.join(h, 'ws/area/proj/repo');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(h, 'ws/CLAUDE.md'), 'x'); // 파일
    fs.mkdirSync(path.join(h, 'ws/area/proj/.claude')); // 폴더
    fs.mkdirSync(path.join(h, 'ws/area/CLAUDE.md')); // 폴더인 CLAUDE.md 는 아니다
    fs.writeFileSync(path.join(h, 'CLAUDE.md'), 'x'); // 홈 자체
    fs.mkdirSync(path.join(h, '.claude'));
    fs.writeFileSync(path.join(src, 'CLAUDE.md'), 'x'); // 레포 자기 자신
    assert.deepEqual(detectReadDirs(src, h), [path.join(h, 'ws/area/proj'), path.join(h, 'ws')]);
    assert.deepEqual(detectReadDirs(path.join(h, 'ws'), h), []); // 부모가 홈뿐
    assert.deepEqual(detectReadDirs('/elsewhere/repo', h), []); // 홈 밖
  } finally { fs.rmSync(h, { recursive: true, force: true }); }
});
