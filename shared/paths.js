import path from 'node:path';

/**
 * base 아래의 안전한 경로를 만든다. 벗어나는 입력은 BAD_PATH
 * @param {string} base
 * @param {string} rel `/` 구분 상대 경로
 * @returns {string}
 */
export function safeJoin(base, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || rel.includes('\\')
    || rel.startsWith('/') || path.isAbsolute(rel) || rel.split('/').includes('..')) {
    throw new Error('BAD_PATH');
  }
  const root = path.resolve(base);
  const full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep)) throw new Error('BAD_PATH');
  return full;
}
