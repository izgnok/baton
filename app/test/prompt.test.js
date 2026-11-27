import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, buildSystemPrompt } from '../main/runner/prompt.js';

test('사람끼리 채팅(chatsSince)은 무시하고 요청만 넘긴다', () => {
  const chatsSince = [{ name: 'B', body: '페이징은 빼도 될 듯' }];
  assert.equal(buildPrompt({ chatsSince, requesterName: 'A', body: '페이징 빼고 구현해줘' }), '[요청 - A]\n페이징 빼고 구현해줘');
  assert.equal(buildPrompt({ requesterName: 'A', body: '해줘\n두 줄' }), '[요청 - A]\n해줘\n두 줄');
});

test('/ 로 시작하는 본문은 감싸지 않고 그대로(스킬 실행)', () => {
  assert.equal(buildPrompt({ requesterName: 'A', body: '/review 123 --fast' }), '/review 123 --fast');
  assert.equal(buildPrompt({ requesterName: 'A', body: '/plugin:skill 인자' }), '/plugin:skill 인자');
  assert.equal(buildPrompt({ requesterName: 'A', body: 'a /b' }), '[요청 - A]\na /b');
});

test('안내문: 레포 없음이어도 레포 정하기 규칙이 있다, 목록 상한', () => {
  const none = buildSystemPrompt({ requesterName: 'A', memoryIndex: '- m', repos: [] });
  assert.ok(none.includes('[연결된 레포] 없음') && none.endsWith('[방 메모리 목차]\n- m'));
  assert.ok(none.includes('room_set_repo') && none.includes('그 레포가 방에 없거나 기준 브랜치가 정해져 있지 않을 때만'));
  assert.ok(!none.includes('[이 PC 의 레포 목록'));

  const sys = buildSystemPrompt({
    requesterName: 'A', memoryIndex: '(아직 없음)', repos: [],
    indexRepos: Array.from({ length: 120 }, (_, i) => ({ name: `r${i}`, path: `/home/me/r${i}` })),
  });
  assert.ok(sys.includes('- r99: /home/me/r99') && !sys.includes('- r100:') && sys.includes('(외 20개)'));
});

test('안내문: 레포 줄은 기준 → 작업(없으면 기준만) + 사본 경로, push 는 작업 브랜치(없으면 기준)로, 보호 브랜치는 금지', () => {
  const sys = buildSystemPrompt({
    requesterName: 'A', memoryIndex: '-',
    repos: [
      { name: 'api', baseBranch: 'release/15.7.0', workBranch: 'feature/NMRS-1', dir: 'repos/1-api' },
      { name: 'web', baseBranch: 'feature/ABC-1', workBranch: '', dir: 'repos/2-web' },
      { name: 'dev', baseBranch: 'develop', dir: 'repos/3-dev' },
      { name: 'rel', baseBranch: 'feature/ABC-2', workBranch: 'release/9', dir: 'repos/4-rel' },
    ],
  });
  assert.ok(sys.includes('- api · 기준 release/15.7.0 → 작업 feature/NMRS-1 / 사본 ./repos/1-api'));
  assert.ok(sys.includes('- web · 기준 feature/ABC-1 / 사본 ./repos/2-web') && !sys.includes('web · 기준 feature/ABC-1 →'));
  assert.ok(sys.includes('git -C ./repos/1-api push -u origin HEAD:refs/heads/feature/NMRS-1'));
  assert.ok(sys.includes('git -C ./repos/2-web push -u origin HEAD:refs/heads/feature/ABC-1'));
  // 기준이 보호 브랜치여도 작업 브랜치가 있으면 그쪽으로 올린다. 올릴 브랜치가 보호 브랜치면 금지
  assert.ok(sys.includes('dev: develop 는 보호 브랜치라 push 하지 않는다') && !sys.includes('refs/heads/develop'));
  assert.ok(sys.includes('rel: release/9 는 보호 브랜치라 push 하지 않는다') && !sys.includes('refs/heads/release/9'));
});

test('안내문: 브랜치를 옮기지 않고(U14), push 는 시킬 때만, 기준 변경 전 확인, 옛 안내(방이 따라온다·대기 브랜치)는 없다', () => {
  const sys = buildSystemPrompt({ requesterName: 'A', memoryIndex: '-', repos: [{ name: 'api', baseBranch: 'develop', workBranch: 'feature/X', dir: 'repos/1-api' }] });
  assert.ok(sys.includes('`git switch`·`git checkout -b` 등으로 브랜치를 옮기지 않는다'));
  assert.ok(sys.includes('그때만 room_set_repo 로 기준·작업 브랜치를 바꾼다') && sys.includes('push 안 한 변경이 있으면 먼저 알리고 확인받는다'));
  assert.ok(sys.includes('"push 해줘"') && sys.includes('작업 단위로 나눠 커밋') && sys.includes('`[키] feat|fix|refactor: 요약`'));
  assert.ok(sys.includes('새로 정한 레포는 다음 요청부터 사본이 생긴다'));
  assert.ok(!sys.includes('방이 따라') && !sys.includes('아직 원격에 없음') && !sys.includes('switch -c'));
});
