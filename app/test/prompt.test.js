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

test('안내문: 레포 없음, 보호 브랜치 push 금지, 목록 상한', () => {
  const none = buildSystemPrompt({ requesterName: 'A', memoryIndex: '- m', repos: [] });
  assert.ok(none.includes('[연결된 레포] 없음') && none.endsWith('[방 메모리 목차]\n- m'));
  assert.ok(!none.includes('[이 PC 의 레포 목록'));

  const sys = buildSystemPrompt({
    requesterName: 'A', memoryIndex: '(아직 없음)',
    repos: [{ name: 'payment-api', branch: 'release/1.0', dir: 'repos/1-payment-api' }, { name: 'web', branch: 'feature/ABC-1', dir: 'repos/2-web' }],
    indexRepos: Array.from({ length: 120 }, (_, i) => ({ name: `r${i}`, path: `/home/me/r${i}` })),
  });
  assert.ok(sys.includes('payment-api: 방 브랜치 release/1.0 (보호 브랜치, push 금지)'));
  assert.ok(sys.includes('- payment-api: 보호 브랜치') && !sys.includes('push origin HEAD:refs/heads/release/1.0'));
  assert.ok(sys.includes('git -C ./repos/2-web push origin HEAD:refs/heads/feature/ABC-1'));
  assert.ok(sys.includes('- r99: /home/me/r99') && !sys.includes('- r100:') && sys.includes('(외 20개)'));
});

test('안내문: 지금 작업 중인 브랜치로 push, 브랜치 이동 안내, 대기 브랜치 표시, 보호 판정은 현재 브랜치 기준', () => {
  const sys = buildSystemPrompt({
    requesterName: 'A', memoryIndex: '-',
    repos: [
      { name: 'api', branch: 'feature/ABC-1', dir: 'repos/1-api', pendingBranch: 'feature/X' },
      { name: 'dev', branch: 'develop', dir: 'repos/2-dev' },
      { name: 'rel', branch: 'feature/ABC-2', dir: 'repos/3-rel', pendingBranch: 'release/9' },
    ],
  });
  assert.ok(sys.includes('git push -u origin <현재 브랜치>') && sys.includes('방이 따라'));
  // 대기 브랜치: 그 브랜치로 push
  assert.ok(sys.includes('(지금 브랜치 feature/X, 아직 원격에 없음 — push 하면 모두 따라감)'));
  assert.ok(sys.includes('git -C ./repos/1-api push -u origin feature/X'));
  assert.ok(!sys.includes('HEAD:refs/heads/feature/ABC-1'));
  // 방 브랜치가 보호 브랜치여도 새 브랜치를 만들어 올리는 건 된다
  assert.ok(sys.includes('dev: 보호 브랜치') && sys.includes('git -C ./repos/2-dev switch -c <새 브랜치>'));
  assert.ok(!sys.includes('push origin HEAD:refs/heads/develop'));
  // 대기 브랜치 자체가 보호 브랜치면 push 하지 않는다(방 브랜치는 보호가 아니어도)
  assert.ok(sys.includes('rel: 지금 브랜치 release/9 는 보호 브랜치') && !sys.includes('push -u origin release/9'));
});
