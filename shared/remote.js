/**
 * git 원격 주소를 비교용 값 `host/path` 로 맞춘다
 * @param {string} url
 * @returns {string}
 */
export function normalizeRemote(url) {
  let s = String(url ?? '').trim()
    .replace(/^(https?|ssh|git):\/\//i, '')
    .replace(/^[^/@]+@/, '')
    .replace(/^([^/:]+):\d+(?=\/|$)/, '$1') // ssh://host:22/... 의 포트
    .replace(':', '/'); // scp 형식 host:path
  s = s.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  const i = s.indexOf('/');
  return i < 0 ? s.toLowerCase() : s.slice(0, i).toLowerCase() + s.slice(i);
}
