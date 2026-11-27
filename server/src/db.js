import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  invite_code TEXT NOT NULL UNIQUE,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  claude_session_id TEXT,
  transcript_version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS room_members (
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, user_id)
);
CREATE TABLE IF NOT EXISTS room_repos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  remote_url TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  work_branch TEXT NOT NULL DEFAULT '',
  origin_branch TEXT
);
CREATE TABLE IF NOT EXISTS code_states (
  repo_id INTEGER PRIMARY KEY REFERENCES room_repos(id) ON DELETE CASCADE,
  base_commit TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  size INTEGER NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS code_parts (
  repo_id INTEGER NOT NULL REFERENCES room_repos(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  prev_snapshot TEXT,
  snapshot TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, seq)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT,
  request_id INTEGER,
  error TEXT,
  queued_at INTEGER,
  created_at INTEGER NOT NULL
);
`;

/**
 * DB 를 열고 스키마를 만든다. ':memory:' 허용
 * @param {string} path
 * @returns {DatabaseSync}
 */
export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  // 옛 DB 에 없는 칸은 데이터를 둔 채 덧붙인다
  const have = new Set(db.prepare('PRAGMA table_info(rooms)').all().map((c) => c.name));
  for (const col of ['default_model', 'default_effort']) {
    if (!have.has(col)) db.exec(`ALTER TABLE rooms ADD COLUMN ${col} TEXT`);
  }
  // 기존 방도 공개(1)로 시작한다. fork_pending: 다음 실행이 claude_session_id 를 --fork-session 으로 이어 받아야 함
  for (const col of ['is_public INTEGER NOT NULL DEFAULT 1', 'fork_pending INTEGER NOT NULL DEFAULT 0']) {
    if (!have.has(col.split(' ')[0])) db.exec(`ALTER TABLE rooms ADD COLUMN ${col}`);
  }
  // 레포: branch → base_branch 로 이름을 바꾸고 work_branch·origin_branch 를 덧붙인다(옛 행의 origin_branch 는 기준과 같게)
  const repoCols = new Set(db.prepare('PRAGMA table_info(room_repos)').all().map((c) => c.name));
  if (repoCols.has('branch') && !repoCols.has('base_branch')) db.exec('ALTER TABLE room_repos RENAME COLUMN branch TO base_branch');
  if (!repoCols.has('work_branch')) db.exec("ALTER TABLE room_repos ADD COLUMN work_branch TEXT NOT NULL DEFAULT ''");
  if (!repoCols.has('origin_branch')) db.exec('ALTER TABLE room_repos ADD COLUMN origin_branch TEXT');
  db.exec('UPDATE room_repos SET origin_branch = base_branch WHERE origin_branch IS NULL');
  return db;
}
