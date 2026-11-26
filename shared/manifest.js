import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * 폴더 아래 일반 파일의 상대 경로와 sha256. 심볼릭 링크와 .tmp- 파일은 뺀다
 * @param {string} dir
 * @returns {{path: string, sha256: string}[]} path 오름차순, 폴더가 없으면 []
 */
export function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = (d, prefix) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.tmp-')) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), rel);
      else if (e.isFile()) {
        out.push({ path: rel, sha256: createHash('sha256').update(fs.readFileSync(path.join(d, e.name))).digest('hex') });
      }
    }
  };
  walk(dir, '');
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
