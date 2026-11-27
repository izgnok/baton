import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listSkills } from '../main/skills.js';

let tmp;
let cfg;
const put = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-skills-'));
  cfg = path.join(tmp, 'claude-config');
  process.env.CLAUDE_CONFIG_DIR = cfg;
  // 개인 스킬(한 줄 설명, 여러 줄 설명, name 없음, SKILL.md 없는 폴더)
  put(path.join(cfg, 'skills/api-spec/SKILL.md'), '---\nname: api-spec\ndescription: "API 명세 만들기"\n---\n본문');
  put(path.join(cfg, 'skills/long/SKILL.md'), '---\nname: long\ndescription: >\n  첫 줄\n  둘째 줄\nother: x\n---\n');
  put(path.join(cfg, 'skills/noname/SKILL.md'), '---\ndescription: 이름 없음\n---\n');
  fs.mkdirSync(path.join(cfg, 'skills/empty'), { recursive: true });
  // 명령
  put(path.join(cfg, 'commands/deploy.md'), '---\ndescription: 배포\n---\n내용');
  put(path.join(cfg, 'commands/plain.md'), '내용만');
  put(path.join(cfg, 'commands/readme.txt'), 'x');
  // 플러그인: 켜 둔 것(버전 두 개 중 최근 것), 꺼 둔 것
  put(path.join(cfg, 'settings.json'), JSON.stringify({ enabledPlugins: { 'super@market': true, 'off@market': false, 'ghost@market': true } }));
  put(path.join(cfg, 'plugins/cache/market/super/1.0.0/skills/old/SKILL.md'), '---\nname: old\ndescription: 옛 버전\n---\n');
  put(path.join(cfg, 'plugins/cache/market/super/2.0.0/skills/brainstorm/SKILL.md'), '---\nname: brainstorm\ndescription: 설계 정리\n---\n');
  put(path.join(cfg, 'plugins/cache/market/off/1.0.0/skills/hidden/SKILL.md'), '---\nname: hidden\n---\n');
  const old = new Date(Date.now() - 86400000);
  fs.utimesSync(path.join(cfg, 'plugins/cache/market/super/1.0.0'), old, old);
  // 프로젝트 스킬
  put(path.join(tmp, 'wt/.claude/skills/deploy-check/SKILL.md'), '---\nname: deploy-check\ndescription: 배포 점검\n---\n');
});
after(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('listSkills: 개인 스킬·명령·켜 둔 플러그인(최신 버전)·프로젝트 스킬, 실패한 항목은 건너뜀', () => {
  const list = listSkills({ workDirs: [path.join(tmp, 'wt'), path.join(tmp, 'no-such')] });
  const by = Object.fromEntries(list.map((s) => [`${s.source}:${s.name}`, s.description]));
  assert.deepEqual(by, {
    'user:api-spec': 'API 명세 만들기',
    'user:long': '첫 줄 둘째 줄',
    'user:noname': '이름 없음', // name 이 없으면 폴더 이름
    'user:deploy': '배포',
    'user:plain': '',
    'plugin:super:brainstorm': '설계 정리', // 옛 버전의 old 는 없다, 꺼 둔 플러그인과 캐시 없는 플러그인도 없다
    'project:deploy-check': '배포 점검',
  });
});

test('listSkills: CLAUDE_CONFIG_DIR 가 없는 폴더여도 빈 목록', () => {
  assert.deepEqual(listSkills({ claudeDir: path.join(tmp, 'nothing') }), []);
});
