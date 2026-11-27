import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MSG } from '@baton/shared/protocol.js';
import { normalizeRemote } from '@baton/shared/remote.js';
import { matchRepo } from './repoIndex.js';
import { inspectRepo } from './runner/preflight.js';
import { assertBranch } from './runner/worktree.js';

const run = promisify(execFile);
const LOCAL_LIMIT = 50;

// 한글 받침 판정: [받침 있음, ㄹ 받침]. 한글이 아니면(영문·숫자 끝) 받침 없음으로 본다
function finalOf(word) {
  const c = String(word).trim().slice(-1).charCodeAt(0);
  if (!(c >= 0xac00 && c <= 0xd7a3)) return [false, false];
  const j = (c - 0xac00) % 28;
  return [j !== 0, j === 8];
}
const eulReul = (w) => (finalOf(w)[0] ? '을' : '를');
const euro = (w) => { const [has, rieul] = finalOf(w); return has && !rieul ? '으로' : '로'; };

/**
 * 원격에 브랜치가 있는지. 원본 경로(그 경로의 origin)나 원격 주소/경로를 받는다. 닿지 못하면 던진다
 * @returns {Promise<boolean>}
 */
export async function defaultLsRemote(target, branch) {
  const ref = `refs/heads/${branch}`;
  const args = fs.existsSync(path.join(target, '.git'))
    ? ['-C', target, 'ls-remote', '--heads', 'origin', ref]
    : ['ls-remote', '--heads', '--', target, ref];
  let out;
  try {
    out = (await run('git', args, { timeout: 30000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout;
  } catch {
    throw new Error('원격에 닿지 못했어요');
  }
  return out.split('\n').some((l) => l.split('\t')[1] === ref);
}

const defaultOpenPath = (p) => run('open', [p]).then(() => {});

/**
 * 방 도구 처리기. 승인 다리의 onTool(name, input) 로 쓴다
 * @returns {(name: string, input: object) => Promise<string>}
 */
export function createRoomTools({
  roomId, requestId, client, getState, repoIndex, getSource, setSource, worktreeOf, syncRepo, removeCopy,
  openPath = defaultOpenPath, lsRemote = defaultLsRemote,
}) {
  const findRepo = (id) => {
    const repo = getState().repos.find((r) => r.id === id);
    if (!repo) throw new Error(`방에 #${id} 레포가 없어요`);
    return repo;
  };

  const handlers = {
    async room_repos() {
      const { repos, members = [] } = getState();
      if (!repos.length) return '방에 레포가 없어요';
      return repos.map((r) => {
        const code = r.code
          ? `코드: 조각 ${r.code.parts}개(마지막 변경 ${members.find((m) => m.userId === r.code.updatedBy)?.name ?? r.code.updatedBy})`
          : '코드: 기준 브랜치 그대로';
        const linked = getSource(r.id) ? '이 맥 원본 연결됨' : '이 맥 원본 연결 안 됨';
        return `#${r.id} ${r.name} · 기준 ${r.baseBranch}${r.workBranch ? ` → 작업 ${r.workBranch}` : ''} · ${r.remoteUrl} · ${code} · ${linked}`;
      }).join('\n');
    },

    async local_repos({ query } = {}) {
      const q = String(query ?? '').trim().toLowerCase();
      const hits = repoIndex.filter((r) => !q || `${r.name}\n${r.remoteUrl}`.toLowerCase().includes(q));
      if (!hits.length) return q ? `이 맥에서 "${query}" 에 맞는 레포를 못 찾았어요` : '이 맥에서 찾은 레포가 없어요';
      const lines = hits.slice(0, LOCAL_LIMIT).map((r) => `${r.name} · ${r.remoteUrl || '(원격 없음)'}`);
      if (hits.length > LOCAL_LIMIT) lines.push(`… 총 ${hits.length}개 중 ${LOCAL_LIMIT}개만 보여요`);
      return lines.join('\n');
    },

    async room_set_repo({ repoId, remoteUrl, name, baseBranch, workBranch }) {
      await assertBranch(baseBranch);
      if (workBranch) await assertBranch(workBranch);
      if (typeof remoteUrl !== 'string' || !remoteUrl.trim()) throw new Error('원격 주소가 비어 있어요');
      const before = repoId == null ? null : findRepo(repoId);
      const inIndex = matchRepo(repoIndex, remoteUrl);
      const source = (repoId != null && getSource(repoId)) || inIndex;
      if (!await lsRemote(source || remoteUrl, baseBranch)) throw new Error(`기준 브랜치 ${baseBranch} 가 원격에 없어요`);

      const repo = await client.request(MSG.ROOM_REPO_SET, {
        requestId, ...(repoId != null && { repoId }), remoteUrl, ...(name && { name }), baseBranch, ...(workBranch && { workBranch }),
      });
      const n = repo?.name ?? name ?? before?.name ?? path.basename(remoteUrl.replace(/\.git$/, ''));
      const base = repo?.baseBranch ?? baseBranch;
      const work = repo?.workBranch ?? workBranch;
      let text = work
        ? `${n}${eulReul(n)} ${base}에서 ${work}${euro(work)} 작업해요`
        : `${n}${eulReul(n)} ${base} 기준으로 작업해요`;
      if (!before) {
        text += ' (다음 요청부터 작업 폴더가 생겨요)';
        if (!inIndex) text += ' 이 맥에는 아직 없어 자동으로 받아요';
      } else if (before.baseBranch !== base) {
        text += ' (코드 상태를 새 기준에서 다시 시작해요)';
      }
      return text;
    },

    async room_remove_repo({ repoId }) {
      const repo = findRepo(repoId);
      await client.request(MSG.ROOM_REPO_REMOVE, { requestId, repoId });
      return `${repo.name}${eulReul(repo.name)} 방에서 뺐어요`;
    },

    async room_open_folder({ repoId }) {
      const dir = worktreeOf(findRepo(repoId));
      if (!dir || !fs.existsSync(dir)) throw new Error('아직 이 맥에 사본이 없어요');
      await openPath(dir);
      return `${dir}${eulReul(dir)} 열었어요`;
    },

    async room_relink({ repoId, path: p }) {
      const repo = findRepo(repoId);
      const dir = path.resolve(String(p).replace(/^~(?=$|\/)/, os.homedir()));
      let info;
      try { info = await inspectRepo(dir); } catch { throw new Error(`${dir} 는 git 레포가 아니에요`); }
      if (!info.remoteUrl || normalizeRemote(info.remoteUrl) !== normalizeRemote(repo.remoteUrl)) {
        throw new Error(`${info.localPath} 의 원격 주소가 ${repo.name} 레포(${repo.remoteUrl})와 달라요`);
      }
      setSource(repoId, info.localPath); // 하위 폴더를 줘도 레포 최상위를 원본으로 쓴다
      await syncRepo(repoId);
      return `${repo.name} 원본을 ${info.localPath}${euro(info.localPath)} 다시 이었어요`;
    },

    async room_reclone({ repoId }) {
      const repo = findRepo(repoId);
      await removeCopy(repoId); // 안 올린 변경이 있으면 여기서 던진다
      await syncRepo(repoId);
      return `${repo.name} 사본을 지우고 다시 받았어요`;
    },
  };

  return async (name, input = {}) => {
    const fn = handlers[name];
    if (!fn) throw new Error(`알 수 없는 방 도구예요: ${name}`);
    return fn(input);
  };
}
