#!/usr/bin/env node
// 테스트용 가짜 claude: FAKE_STREAM 줄 출력, FAKE_STDERR, FAKE_EXIT, FAKE_RECORD,
// FAKE_SLEEP_MS(출력 전 대기), FAKE_TRANSCRIPT(대화 원본 쓰기), FAKE_SHARED_WRITE(shared 아래 파일 쓰기),
// FAKE_REPO_WRITE(첫 --add-dir 폴더 아래 파일 쓰기), FAKE_REPO_WRITE_SEQ(JSON [파일…] — 실행할 때마다 다음 파일을 쓴다, 횟수는 FAKE_SEQ_FILE 에 기록), FAKE_REPO_GIT(첫 --add-dir 폴더에서 git 실행, JSON [[인자…], …])
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

let stdin = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) stdin += chunk;

if (process.env.FAKE_RECORD) {
  const argv = process.argv.slice(2);
  const mcpFile = argv[argv.indexOf('--mcp-config') + 1];
  fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify({
    argv, stdin, cwd: process.cwd(),
    extraFlag: process.env.EXTRA_FLAG ?? null,
    apiKey: process.env.ANTHROPIC_API_KEY ?? null,
    authToken: process.env.ANTHROPIC_AUTH_TOKEN ?? null,
    claudeMdEnv: process.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD ?? null,
    mcp: mcpFile && fs.existsSync(mcpFile) ? JSON.parse(fs.readFileSync(mcpFile, 'utf8')) : null, // 실행 중에만 있는 설정
  }));
}
if (process.env.FAKE_SLEEP_MS) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_SLEEP_MS)));
if (process.env.FAKE_TRANSCRIPT && process.env.FAKE_STREAM) {
  const first = fs.readFileSync(process.env.FAKE_STREAM, 'utf8').split('\n').find((l) => l.includes('session_id'));
  const sid = JSON.parse(first).session_id;
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, '.claude');
  const dir = path.join(configDir, 'projects', fs.realpathSync(process.cwd()).replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), process.env.FAKE_TRANSCRIPT);
}
if (process.env.FAKE_SHARED_WRITE) {
  const f = path.join(process.cwd(), 'shared', process.env.FAKE_SHARED_WRITE);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '결과물');
}
if (process.env.FAKE_REPO_WRITE) {
  const argv = process.argv.slice(2);
  const f = path.join(argv[argv.indexOf('--add-dir') + 1], process.env.FAKE_REPO_WRITE);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '고친 코드');
}
if (process.env.FAKE_REPO_WRITE_SEQ && process.argv.includes('--add-dir')) { // 작업 폴더가 없으면 쓰지 않는다(레포 밖에 파일이 새지 않게)
  const argv = process.argv.slice(2);
  const counter = process.env.FAKE_SEQ_FILE;
  const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
  fs.writeFileSync(counter, String(n + 1));
  const f = path.join(argv[argv.indexOf('--add-dir') + 1], JSON.parse(process.env.FAKE_REPO_WRITE_SEQ)[n]);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, `고친 코드 ${n}`);
}
if (process.env.FAKE_REPO_GIT) {
  const argv = process.argv.slice(2);
  const cwd = argv[argv.indexOf('--add-dir') + 1];
  for (const a of JSON.parse(process.env.FAKE_REPO_GIT)) execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, stdio: 'pipe' });
}
if (process.env.FAKE_STDERR) process.stderr.write(process.env.FAKE_STDERR);
if (process.env.FAKE_STREAM) process.stdout.write(fs.readFileSync(process.env.FAKE_STREAM, 'utf8'));
process.exitCode = Number(process.env.FAKE_EXIT ?? 0);
