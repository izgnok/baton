import path from 'node:path';
import { isProtectedBranch } from './worktree.js';

/**
 * claude 에 넘길 프롬프트. 사람끼리 채팅은 넘기지 않는다. 본문이 / 로 시작하면 스킬 실행이라 그대로 넘긴다
 * @param {{requesterName: string, body: string}} p
 */
export function buildPrompt({ requesterName, body }) {
  if (body.trimStart().startsWith('/')) return body;
  return `[요청 - ${requesterName}]\n${body}`;
}

const MAX_INDEX_REPOS = 100;

/**
 * 방 안내문(--append-system-prompt). 경로는 방 폴더 기준 상대 경로이거나 이번 실행 PC 의 절대 경로다
 * @param {{requesterName: string, memoryIndex: string,
 *   repos: {name: string, branch: string, dir: string}[],
 *   readDirs: string[], indexRepos: {name: string, path: string}[]}} p
 *   repos[].dir 은 방 작업 폴더의 방 폴더 기준 상대 경로(`repos/1-name`)
 */
export function buildSystemPrompt({ requesterName, memoryIndex, repos, readDirs = [], indexRepos = [] }) {
  const L = [
    '이 대화는 여러 사람이 각자 자기 PC 에서 이어 쓰는 채팅방이다. 사용자 메시지는 [요청 - 이름] 으로 시작하고, 이름이 요청한 사람이다. 요청마다 실행되는 PC 가 다를 수 있다.',
    '앞 대화에 나온 절대 경로(/Users/... 등)는 다른 사람 PC 의 경로일 수 있으니 쓰지 않는다. 경로는 지금 작업 폴더(방 폴더) 기준 상대 경로를 쓰고, 절대 경로가 필요하면 아래에 적힌 이 PC 의 경로만 쓴다.',
    `이번 실행 PC 는 ${requesterName} 님의 PC 다(이 PC 기준).`,
    '방 공유 폴더는 ./shared 다. 실행이 끝나면 이 폴더가 다른 사람 PC 와 맞춰진다.',
    '방 메모리: ./shared/memory (목차 INDEX.md). 이 방에서 새로 알게 된 사실·결정은 여기에 md 로 남기고 INDEX.md 에 한 줄 추가한다.',
    '문서·HTML 같은 결과물: ./shared/outputs',
    '',
  ];

  if (repos.length) {
    L.push('[연결된 레포]');
    for (const r of repos) {
      const prot = isProtectedBranch(r.branch);
      L.push(`- ${r.name}: 방 브랜치 ${r.branch}${prot ? ' (보호 브랜치, push 금지)' : ''} / 방 작업 폴더 ./${r.dir}`);
    }
    L.push(
      '코드 수정은 방 작업 폴더에서만 한다(detached HEAD 다).',
      '고친 뒤에는 커밋·push 하지 말고 바뀐 점을 요약한 뒤 "커밋·push 할까요?" 라고 묻는다.',
      '사용자가 하라고 하면:',
      '1. 로컬 설정·비밀값 파일(*-local.yml, application-local.yml, .env*, 키 파일, jdbc.properties 등)은 제외하고 git add 한다.',
      '2. 커밋 메시지: 방 브랜치 이름에 이슈 키([A-Z][A-Z0-9]+-\\d+)가 있으면 `[키] feat|fix|refactor: 요약`, 없으면 `feat: 요약`.',
      '3. 레포별 push 명령(작업 폴더는 detached 라 브랜치를 반드시 지정한다):',
    );
    for (const r of repos) {
      L.push(isProtectedBranch(r.branch)
        ? `   - ${r.name}: 보호 브랜치(main·master·develop·production·release/*·hotfix/*)라 push 하지 않는다`
        : `   - ${r.name}: git -C ./${r.dir} push origin HEAD:refs/heads/${r.branch}`);
    }
    L.push('4. push 가 거절되면 fetch·rebase 후 다시 push 한다. 충돌이면 멈추고 사람에게 알린다.', '');
  } else {
    L.push('[연결된 레포] 없음', '');
  }

  if (readDirs.length) {
    L.push('[함께 읽는 폴더 - 이 PC 기준]');
    for (const d of readDirs) L.push(`- ${path.basename(d)}: ${d}`);
    L.push('읽기만 한다. 수정 금지. 원본 폴더에서 checkout·switch 금지.', '');
  }
  if (indexRepos.length) {
    L.push('[이 PC 의 레포 목록 - 이 PC 기준]');
    for (const r of indexRepos.slice(0, MAX_INDEX_REPOS)) L.push(`- ${r.name}: ${r.path}`);
    if (indexRepos.length > MAX_INDEX_REPOS) L.push(`(외 ${indexRepos.length - MAX_INDEX_REPOS}개)`);
    L.push('읽기만 한다. 수정 금지. 원본 폴더에서 checkout·switch 금지.', '');
  }
  if (readDirs.length || indexRepos.length || repos.length) {
    L.push(
      '[특정 브랜치 읽기]',
      '다른 브랜치 내용은 원본 폴더를 바꾸지 말고 mcp__rooms__git_read 도구로 읽는다. repo 는 위 목록의 이 PC 경로다.',
      '- 받기: args ["fetch","origin","<브랜치>"] → 그 뒤 args ["show","origin/<브랜치>:<경로>"], ["grep","-n","<패턴>","origin/<브랜치>"], ["ls-tree","-r","--name-only","origin/<브랜치>"], ["log","origin/<브랜치>"], ["diff","origin/<브랜치>...HEAD"] 등.',
      '',
    );
  }

  L.push('[방 메모리 목차]', memoryIndex);
  return L.join('\n');
}
