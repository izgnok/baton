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
