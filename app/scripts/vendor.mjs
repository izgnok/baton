// marked(ESM)와 Pretendard 글꼴을 renderer/vendor 로 복사한다. CSP 때문에 CDN 을 못 쓴다
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(appDir, 'renderer', 'vendor');

// app/node_modules → 상위 node_modules(워크스페이스 호이스팅) 순서로 찾는다
function find(rel) {
  for (let d = appDir; ; d = path.dirname(d)) {
    const f = path.join(d, 'node_modules', rel);
    if (fs.existsSync(f)) return f;
    if (path.dirname(d) === d) throw new Error(`찾을 수 없음: ${rel} (npm install 먼저)`);
  }
}

fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(find('marked/lib/marked.esm.js'), path.join(out, 'marked.esm.js'));
fs.copyFileSync(find('pretendard/dist/web/variable/woff2/PretendardVariable.woff2'), path.join(out, 'PretendardVariable.woff2'));
