import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 파일 맨 앞 `---` 블록의 key: value 읽기(여러 줄 값 `>`·`|` 와 들여쓴 이어지는 줄 포함) */
function frontmatter(file) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(fs.readFileSync(file, 'utf8'));
  const out = {};
  if (!m) return out;
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^[>|][+-]?$/.test(v) || v === '') {
      const parts = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim());
      v = parts.join(' ');
    }
    out[kv[1]] = v.replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

const subdirs = (dir) => {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; }
};

// dir/*/SKILL.md 들. 읽지 못한 항목은 건너뛴다
function skillsIn(dir, source, prefix = '') {
  const out = [];
  for (const d of subdirs(dir)) {
    try {
      const fm = frontmatter(path.join(dir, d, 'SKILL.md'));
      out.push({ name: `${prefix}${fm.name || d}`, description: fm.description ?? '', source });
    } catch { /* SKILL.md 없음·깨짐 */ }
  }
  return out;
}

const newestChild = (dir) => subdirs(dir)
  .map((d) => ({ d, t: fs.statSync(path.join(dir, d)).mtimeMs }))
  .sort((a, b) => b.t - a.t)[0]?.d;

/**
 * 이 PC 에서 쓸 수 있는 스킬 목록: 개인 스킬·명령, 켜 둔 플러그인 스킬, 방 작업 폴더의 프로젝트 스킬
 * @param {{workDirs?: string[], claudeDir?: string}} [p]
 * @returns {{name: string, description: string, source: 'user'|'plugin'|'project'}[]}
 */
export function listSkills({ workDirs = [], claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude') } = {}) {
  const out = skillsIn(path.join(claudeDir, 'skills'), 'user');

  const cmdDir = path.join(claudeDir, 'commands');
  try {
    for (const f of fs.readdirSync(cmdDir)) {
      if (!f.endsWith('.md')) continue;
      try { out.push({ name: f.slice(0, -3), description: frontmatter(path.join(cmdDir, f)).description ?? '', source: 'user' }); } catch { /* 건너뜀 */ }
    }
  } catch { /* commands 폴더 없음 */ }

  let enabled = {};
  try { enabled = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8')).enabledPlugins ?? {}; } catch { /* 설정 없음 */ }
  for (const [key, on] of Object.entries(enabled)) {
    const [plugin, marketplace] = key.split('@');
    if (on !== true || !plugin || !marketplace) continue;
    try {
      const base = path.join(claudeDir, 'plugins', 'cache', marketplace, plugin);
      const version = newestChild(base); // 버전 폴더가 여러 개면 가장 최근 것
      if (version) out.push(...skillsIn(path.join(base, version, 'skills'), 'plugin', `${plugin}:`));
    } catch { /* 건너뜀 */ }
  }

  for (const dir of workDirs) out.push(...skillsIn(path.join(dir, '.claude', 'skills'), 'project'));
  return out;
}
