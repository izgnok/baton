#!/usr/bin/env node
// 테스트용 가짜 claude: FAKE_STREAM 줄 출력, FAKE_STDERR, FAKE_EXIT, FAKE_RECORD,
// FAKE_SLEEP_MS(출력 전 대기), FAKE_TRANSCRIPT(대화 원본 쓰기), FAKE_SHARED_WRITE(shared 아래 파일 쓰기),
// FAKE_REPO_WRITE(첫 --add-dir 폴더 아래 파일 쓰기), FAKE_REPO_GIT(첫 --add-dir 폴더에서 git 실행, JSON [[인자…], …])
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
if (process.env.FAKE_REPO_GIT) {
  const argv = process.argv.slice(2);
  const cwd = argv[argv.indexOf('--add-dir') + 1];
  for (const a of JSON.parse(process.env.FAKE_REPO_GIT)) execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, stdio: 'pipe' });
}
if (process.env.FAKE_STDERR) process.stderr.write(process.env.FAKE_STDERR);
if (process.env.FAKE_STREAM) process.stdout.write(fs.readFileSync(process.env.FAKE_STREAM, 'utf8'));
process.exitCode = Number(process.env.FAKE_EXIT ?? 0);
