// 앱 소스 폴더(git 클론)의 새 커밋 확인과 업데이트
import * as src from '@rooms/shared/sourceUpdate.js';

/** 서버가 알린 commit(짧은 해시)과 내 HEAD 가 다르면 true. 어느 쪽이든 모르면 false */
export const serverMismatch = (head, commit) => !!head && !!commit && !head.startsWith(commit) && !commit.startsWith(head);

/**
 * @param {{root: string, isBusy: () => boolean, relaunch: () => void, notify: (state: object) => void,
 *   install?: (root: string) => Promise<any>, build?: (root: string) => Promise<any>, appCommit?: string|null, intervalMs?: number, log?: {warn: Function}}} o
 *   appCommit: 지금 돌고 있는 맥 앱을 빌드한 커밋(Info.plist RoomsCommit). 그 뒤로 mac/ 이 바뀌었으면 다시 빌드가 필요하다
 */
export function createUpdater({ root, isBusy, relaunch, notify, install = src.npmInstall, build = src.macBuild, appCommit = null, intervalMs = 30 * 60 * 1000, log = console }) {
  let state = { count: 0, subjects: [], serverMismatch: false, rebuild: false };
  const macChanged = (files) => files.some((f) => f.startsWith('mac/'));
  // 서버 관리 프로그램이 같은 소스 폴더를 먼저 pull 해도, 앱이 예전 커밋으로 빌드돼 있으면 알 수 있게
  async function needsRebuild(head) {
    if (!appCommit || !head || head.startsWith(appCommit)) return false;
    try { return macChanged(await src.changedBetween(root, appCommit, head)); } catch { return false; }
  }
  let timer = null;
  let serverCommit = null;
  const set = (patch) => {
    const next = { ...state, ...patch };
    if (JSON.stringify(next) === JSON.stringify(state)) return;
    state = next;
    notify(state);
  };

  async function check() {
    try {
      const head = await src.sourceHead(root);
      if (!head) return state; // git 최상위가 아니면 확인하지 않는다
      const { count, subjects } = await src.fetchBehind(root);
      set({ count, subjects, rebuild: await needsRebuild(head) });
    } catch (e) {
      log.warn(`업데이트 확인 실패: ${e.message}`);
    }
    return state;
  }

  async function recheckServer() {
    set({ serverMismatch: serverMismatch(await src.sourceHead(root), serverCommit) });
  }

  return {
    state: () => state,
    check,
    start() {
      check();
      timer = setInterval(check, intervalMs);
      timer.unref?.();
    },
    stop() { clearInterval(timer); },
    /** 서버가 알려 준 commit 을 내 HEAD 와 비교한다 */
    async setServerCommit(commit) {
      serverCommit = commit ?? null;
      await recheckServer();
    },
    /** pull → (lock 이 바뀌면) npm install → (mac/ 이 바뀌면) 맥 앱 빌드 → 다시 켜기. 못 하면 코드로 던지고 지금 버전을 그대로 둔다 */
    async apply() {
      if (isBusy()) throw new Error('UPDATE_BUSY');
      if (!await src.sourceHead(root)) throw new Error('UPDATE_NOT_GIT');
      if (await src.isDirty(root)) throw new Error('UPDATE_LOCAL_CHANGES');
      let r;
      try { r = await src.pullFf(root); } catch { throw new Error('UPDATE_PULL_FAILED'); }
      if (r.lockChanged) {
        try { await install(root); } catch { throw new Error('UPDATE_INSTALL_FAILED'); }
      }
      if (macChanged(r.changed) || await needsRebuild(r.before)) {
        try { await build(root); } catch (e) { log.warn(`맥 앱 빌드 실패: ${e.message}`); throw new Error('UPDATE_BUILD_FAILED'); }
      }
      relaunch();
      return { ok: true };
    },
  };
}
