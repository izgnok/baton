# Claude Rooms 구현 계획

> 실행 방식: 사용자 규칙(`~/.claude/rules/claude-workflow.md`)을 따른다. 범위가 정해진 작업은 `sonnet-worker` 에 맡기고 메인이 diff 를 검토한다. 각 작업이 끝나면 사용자 확인 → 커밋 → 다음 작업 순서로 간다. 단계는 체크박스(`- [ ]`)로 관리한다.

**목표:** 서로 다른 Claude 계정을 쓰는 사람들이 같은 채팅방에서 같은 Claude 대화를 이어 가는 데스크톱 앱과 중계 서버를 만든다.

**구조:** Node 서버(웹소켓 + SQLite)가 방, 메시지, `@claude` 대기열, 대화 원본, 공유 파일을 가진다. Electron 앱은 화면과 실행기로 되어 있고, 실행기는 보낸 사람 맥에서 `claude -p --resume` 를 돌려 결과를 서버로 보낸다.

**기술:** Node 24(ESM, JS + JSDoc), `node:test`, `node:sqlite`, `ws@8`, Electron, `marked`, `@modelcontextprotocol/sdk`

**설계 문서:** `docs/2026-11-26-claude-rooms-design.md` (아래 "설계 N장"은 이 문서를 가리킨다)

## 전체 제약

- 레포: `izgnok/claude-rooms`, 로컬 `~/claude-rooms`. 설계·계획 문서와 화면 캡처는 레포 안 `docs/` 에 둔다(2026-11-26 사용자 결정)
- Node 24 이상. 언어는 JS(ESM) + JSDoc. TypeScript 빌드 단계는 두지 않는다
- 외부 의존은 `ws`, `electron`, `marked`, `@modelcontextprotocol/sdk` 만. 그 밖에는 Node 표준 라이브러리를 쓴다
- 서버는 Claude 로그인 정보를 다루지 않는다
- 각 맥의 방 작업 폴더는 `~/.claude-rooms/<roomId>/`, 앱 로컬 설정은 `~/.claude-rooms/config.json`, clone 기본 위치는 `~/.claude-rooms/repos/<레포 이름>`
- `@claude` 실행은 방마다 한 번에 하나. 신호 주기 10초, 시간 초과 30초
- 화면은 토스 앱 같은 분위기(설계 7.1장). 토스 로고·이름·아이콘·전용 글꼴은 쓰지 않는다. 글꼴은 Pretendard
- **git 은 모든 작업이 끝난 뒤 한 번에 연결한다**(2026-11-26 사용자 결정). 작업마다 커밋하지 않고 로컬 파일로만 진행하며, 각 작업의 "커밋" 단계는 "사용자 확인"으로 대신한다. 마지막에 git init → 커밋 → GitHub `izgnok/claude-rooms` 비공개 레포 생성 → push. 커밋 메시지에 `Co-Authored-By` 같은 AI 표시를 넣지 않는다
- 서버 데이터 폴더(`server/data/`)와 `node_modules/` 는 커밋하지 않는다

## 검토 중점 (테스트가 따로 없으면 놓치기 쉬운 것)

1. 공유 파일 경로에 `../` 나 절대 경로가 들어옴 → 서버와 앱 모두 방 폴더 밖에는 쓰지 않고 거부한다 (작업 4, 작업 9)
2. `@claude` 판정: 앞 공백, `@Claude`, 본문 없는 `@claude` → 앞 공백과 대소문자는 허용하고, 빈 본문은 거부한다 (작업 3)
3. 실행 중에 보낸 사람이 방을 나감 → 실행 중인 요청은 끝까지 가고, 그 사람의 대기 요청은 `held` 가 된다 (작업 3)
4. `claude` 가 스트림 중간에 비정상 종료(종료 코드 ≠ 0, 출력 일부만 있음) → 요청은 `failed`, 대화 원본은 올리지 않는다 (작업 10)
5. 실행 중에 방장이 레포나 브랜치를 바꿈 → 진행 중인 실행은 시작 때 점검한 값으로 끝나고, 바뀐 값은 다음 실행부터 적용한다 (작업 10)

---

## 파일 구조

```
claude-rooms/
  package.json                 npm workspaces: server, app, shared
  .gitignore                   node_modules, server/data
  shared/protocol.js           웹소켓 메시지 타입 상수와 JSDoc 타입, parseClaudeMention()
  server/
    src/db.js                  SQLite 열기·스키마 생성
    src/auth.js                회원가입·로그인·토큰 확인
    src/rooms.js               방·멤버·방장·레포 관리
    src/queue.js               메시지 저장, @claude 대기열·잠금·신호·버전
    src/files.js               대화 원본·공유 파일 저장, 경로 검사
    src/http.js                POST /signup, /login, GET 파일
    src/ws.js                  웹소켓 연결·라우팅·방송
    src/index.js               시작점 (PORT, DATA_DIR 환경 변수)
    test/*.test.js
  app/
    main/index.js              Electron 메인, 창, IPC 연결
    main/serverClient.js       서버 웹소켓 + HTTP 클라이언트, 재연결
    main/localConfig.js        ~/.claude-rooms/config.json 읽기·쓰기
    main/runner/preflight.js   레포 점검
    main/runner/sync.js        대화 원본·공유 파일 내려받기·올리기
    main/runner/prompt.js      프롬프트 조립
    main/runner/claude.js      claude 실행, stream-json 파싱
    main/runner/approve.js     승인 다리(로컬 HTTP) + MCP 설정 파일 생성
    main/runner/approveMcp.js  claude 가 띄우는 stdio MCP 서버 (mcp__rooms__approve)
    main/runner/turn.js        @claude 한 번 처리 순서
    main/preload.js            렌더러에 IPC 노출
    renderer/index.html
    renderer/tokens.css        색·글꼴·간격 토큰 (라이트·다크)
    renderer/app.js            화면 전환·상태
    renderer/views/*.js        login, roomList, room, settings, approvalModal
    test/*.test.js
    test/fixtures/             stream-json 샘플, 가짜 claude 스크립트
  spike/                       작업 0 시험 스크립트 (결과 기록 후 삭제)
```

---

### 작업 0: 가능성 시험 (R1~R3) — 통과해야 다음으로 간다

**파일:** `spike/` 아래 셸 스크립트와 메모. 결과는 설계 문서 10장 표에 "결과" 열로 적는다. 시험 코드는 버린다.

- [ ] **단계 1: R2 — 같은 세션 ID 에 이어 쓰는가 (맥1)**
  `mkdir -p /tmp/rooms-spike && cd /tmp/rooms-spike && claude -p "숫자 7을 기억해" --output-format stream-json --verbose` → 첫 `{"type":"system","subtype":"init"}` 줄의 `session_id` 를 적는다. 이어서 `claude -p "기억한 숫자는?" --resume <id> --output-format stream-json --verbose`.
  통과: 답이 7이고, `~/.claude/projects/-private-tmp-rooms-spike/` 아래 파일이 `<id>.jsonl` 하나에 이어 쓰였다(새 파일이 생기지 않음). 새 ID 로 갈라지면 설계 10장 R2 의 "안 되면" 방식으로 간다.
- [ ] **단계 2: R1 — 다른 계정·다른 위치 (맥1, 두 번째 설정 폴더)**
  `CLAUDE_CONFIG_DIR=~/.claude-b claude` 로 B 계정에 로그인(사용자가 직접). 단계 1 의 jsonl 을 `~/.claude-b/projects/<인코딩된 /tmp/rooms-spike2>/<id>.jsonl` 로 복사하고 `cd /tmp/rooms-spike2 && CLAUDE_CONFIG_DIR=~/.claude-b claude -p "기억한 숫자는?" --resume <id> --output-format stream-json --verbose`.
  통과: 답이 7. 인코딩 규칙은 "경로에서 영숫자가 아닌 글자를 `-` 로 바꾼다"이고, 실제 폴더 이름과 대조해 확인한다.
- [ ] **단계 3: R1 — 실제 맥2**
  단계 1 jsonl 을 맥2 로 옮겨 맥2 사용자명 기준 인코딩 폴더에 넣고 같은 명령을 실행한다. 통과: 답이 7.
- [ ] **단계 4: R3 — 승인 도구**
  `@modelcontextprotocol/sdk` 로 `approve` 도구 하나를 가진 stdio MCP 서버를 만든다. 도구는 받은 입력을 파일에 적고 `{"behavior":"allow","updatedInput":<받은 input>}` 을 JSON 문자열 텍스트로 돌려준다. `claude -p "/tmp/rooms-spike/a.txt 에 hi 라고 써" --mcp-config spike/mcp.json --permission-prompt-tool mcp__rooms__approve --output-format stream-json --verbose`.
  통과: 파일이 만들어지고, 도구가 받은 입력에 `tool_name` 과 `input` 이 있다. 실제 입력 모양을 적어 둔다(작업 8 이 쓴다). `deny` 를 돌려주면 쓰기가 막히는 것도 확인한다.
- [ ] **단계 5: 결과 기록 후 사용자 확인.** 하나라도 실패하면 여기서 멈추고 설계를 다시 본다.

---

### 작업 1: 레포 뼈대, 서버 DB, 회원

**파일:** 생성 `package.json`, `.gitignore`, `shared/protocol.js`, `server/src/db.js`, `server/src/auth.js`, 테스트 `server/test/auth.test.js`

**인터페이스:**
- 만드는 것:
  - `openDb(path: string) → DatabaseSync` — 설계 5.1장 테이블 6개를 `CREATE TABLE IF NOT EXISTS` 로 만든다. `':memory:'` 를 받을 수 있다
  - `signup(db, {email, password, name}) → {token, user:{id,email,name}}` — 이메일 중복이면 `Error('EMAIL_TAKEN')`, 비밀번호 8자 미만이면 `Error('WEAK_PASSWORD')`
  - `login(db, {email, password}) → {token, user}` — 틀리면 `Error('BAD_CREDENTIALS')`
  - `userByToken(db, token) → user | null`
  - 비밀번호: `crypto.scrypt`(salt 16바이트, 저장 형식 `salt:hash` hex), 토큰: `crypto.randomBytes(32).toString('hex')`
  - `shared/protocol.js`: `MSG` 상수 객체(아래 작업들이 쓰는 타입 이름 전부)와 `parseClaudeMention(text) → {isClaude: boolean, body: string}`

- [ ] **단계 1: 테스트 작성** — `signup → login → userByToken` 이 같은 사용자, 같은 이메일 재가입 `EMAIL_TAKEN`, 틀린 비밀번호 `BAD_CREDENTIALS`, 7자 비밀번호 `WEAK_PASSWORD`, 모르는 토큰은 `null`
- [ ] **단계 2: 구현**
- [ ] **단계 3: 실행** — `npm test -w server` → 전부 통과
- [ ] **단계 4: 사용자 확인 후 커밋** `feat: 서버 DB와 회원가입·로그인`

---

### 작업 2: 방과 레포 관리

**파일:** 생성 `server/src/rooms.js`, 테스트 `server/test/rooms.test.js`

**인터페이스:**
- 쓰는 것: 작업 1 `openDb`, `signup`
- 만드는 것 (모두 `(db, userId, …)` 를 받고, 권한이 없으면 `Error('FORBIDDEN')`, 대상이 없으면 `Error('NOT_FOUND')`):
  - `createRoom(db, userId, {name}) → room` — 초대 코드 6자리 대문자·숫자, 만든 사람이 방장이자 첫 멤버
  - `joinRoom(db, userId, {inviteCode}) → room` — 이미 멤버면 그대로 돌려준다
  - `leaveRoom(db, userId, roomId) → void` — 방장이 나가면 `joined_at` 이 가장 이른 멤버가 방장이 된다. 마지막 사람이 나가도 방은 남긴다
  - `renameRoom`, `regenerateInvite`, `deleteRoom` — 방장만
  - `listRooms(db, userId) → room[]`, `getRoomState(db, userId, roomId) → {room, members, repos}` — 멤버만
  - `addRepo(db, userId, roomId, {name, remoteUrl, branch}) → repo`, `updateRepo(db, userId, repoId, {name?, remoteUrl?, branch?}) → repo`, `removeRepo(db, userId, repoId)` — 방장만
  - `normalizeRemote(url) → string` — `git@host:a/b.git` 와 `https://host/a/b(.git)` 를 같은 값 `host/a/b` 로 만든다 (작업 6 도 쓴다)

- [ ] **단계 1: 테스트 작성** — 만들기·코드로 참가·나가기, 방장이 나가면 다음 멤버가 방장, 방장 아닌 사람의 `addRepo`·`deleteRoom` 은 `FORBIDDEN`, 멤버가 아닌 사람의 `getRoomState` 는 `FORBIDDEN`, `normalizeRemote('git@bitbucket.org:example-team/payment-api.git') === normalizeRemote('https://bitbucket.org/example-team/payment-api')`
- [ ] **단계 2: 구현**
- [ ] **단계 3: 실행** — `npm test -w server` → 통과
- [ ] **단계 4: 사용자 확인 후 커밋** `feat: 방·멤버·레포 관리`

---

### 작업 3: 메시지와 `@claude` 대기열

**파일:** 생성 `server/src/queue.js`, 테스트 `server/test/queue.test.js`

**인터페이스:**
- 쓰는 것: 작업 1·2, `parseClaudeMention`
- 만드는 것: `createQueue(db, {now = Date.now, isOnline: (userId) => boolean, dispatch: (userId, runStart) => void, broadcast: (roomId, event) => void}) → queue`
  - `queue.postMessage(userId, roomId, text) → message` — `parseClaudeMention` 이 참이면 `kind='claude_request'`, `status='queued'` 로 저장하고 차례를 확인한다. 아니면 `kind='chat'`. 빈 본문의 `@claude` 는 `Error('EMPTY_REQUEST')`
  - 차례 규칙: 방에 `running` 이 없으면 가장 오래된 `queued` 를 꺼낸다. 보낸 사람이 오프라인이면 `held` 로 바꾸고 다음으로 간다. 온라인이면 `running` 으로 바꾸고 `dispatch(userId, runStart)` 를 부른다
  - `runStart = {requestId, roomId, sessionId, transcriptVersion, requesterName, body, chatsSince: [{name, body}]}` — `chatsSince` 는 직전 `claude_request` 이후의 `chat` 메시지
  - `queue.heartbeat(requestId)`, `queue.tick()` — `tick` 은 마지막 신호 뒤 30000ms 가 지난 `running` 을 `failed` 로 바꾸고 다음 차례를 확인한다
  - `queue.appendEvent(requestId, event)` — `claude_event` 메시지로 저장하고 방송
  - `queue.finish(requestId, {transcriptVersion, sessionId?}) → {newVersion}` — 버전이 `rooms.transcript_version` 과 다르면 `Error('VERSION_MISMATCH')`. 같으면 버전 +1, 처음이면 `claude_session_id` 를 저장하고 `done`
  - `queue.fail(requestId, reason)`, `queue.retry(userId, requestId)` — `held`·`failed` 를 보낸 사람만 대기열 끝으로 다시 넣는다
  - `queue.onLeave(userId, roomId)` — 그 사람의 `queued` 를 `held` 로 바꾼다. `running` 은 건드리지 않는다
  - `queue.recoverOnStart()` — 서버 시작 때 `running` 을 모두 `failed` 로 바꾼다
  - 상태가 바뀔 때마다 `broadcast(roomId, {type: MSG.MESSAGE_UPDATE, message})`

- [ ] **단계 1: 테스트 작성** (가짜 `now`·`isOnline`·`dispatch`)
  - `"  @Claude 안녕"` → `claude_request`, 본문 `"안녕"` / `"@claude   "` → `EMPTY_REQUEST` / `"이메일 a@claude.com"` → `chat`
  - 요청 두 개 → 첫 번째만 `running`, 첫 번째 `finish` 뒤 두 번째 `dispatch`
  - 보낸 사람 오프라인 → `held`, 다음 요청으로 넘어감
  - 신호 없이 30001ms 뒤 `tick` → `failed`, 29999ms 면 그대로
  - 버전 불일치 `finish` → `VERSION_MISMATCH`
  - 실행 중 보낸 사람 `onLeave` → `running` 유지, 그 사람의 `queued` 는 `held`
  - `chatsSince` 에 직전 요청 이후의 한글 채팅만 순서대로 들어감
  - `recoverOnStart` → `running` 이 `failed`
- [ ] **단계 2: 구현**
- [ ] **단계 3: 실행** — `npm test -w server` → 통과
- [ ] **단계 4: 사용자 확인 후 커밋** `feat: 메시지와 @claude 대기열`

---

### 작업 4: 대화 원본과 공유 파일 저장

**파일:** 생성 `server/src/files.js`, 테스트 `server/test/files.test.js`

**인터페이스:**
- 만드는 것: `createFileStore(dataDir) → store`
  - `store.readTranscript(roomId) → string | null`, `store.writeTranscript(roomId, text)` — `data/rooms/<roomId>/transcript.jsonl`
  - `store.manifest(roomId) → [{path, sha256}]` — `shared/` 아래 모든 파일, 경로는 `/` 구분 상대 경로
  - `store.readShared(roomId, path) → Buffer`
  - `store.applyShared(roomId, changes: [{path, contentBase64: string | null}])` — `null` 은 삭제
  - `safeJoin(base, rel) → string` — 결과가 `base` 밖이면 `Error('BAD_PATH')`. 절대 경로, `..`, 빈 경로 거부 (작업 9 도 쓴다)

- [ ] **단계 1: 테스트 작성** — 쓰고 읽기, `manifest` 해시가 내용과 일치, 삭제 반영, `../x`·`/etc/x`·`a/../../x` 는 `BAD_PATH`, 한글 파일 이름 `메모.md` 정상
- [ ] **단계 2: 구현** (`node:fs/promises`, `node:crypto`)
- [ ] **단계 3: 실행** — `npm test -w server` → 통과
- [ ] **단계 4: 사용자 확인 후 커밋** `feat: 대화 원본·공유 파일 저장`

---

### 작업 5: HTTP·웹소켓 연결과 서버 시작

**파일:** 생성 `server/src/http.js`, `server/src/ws.js`, `server/src/index.js`, 테스트 `server/test/server.test.js`

**인터페이스:**
- 쓰는 것: 작업 1~4
- 만드는 것: `startServer({port, dataDir}) → {close(), port}`
  - HTTP: `POST /signup`, `POST /login` → `{token, user}` / `GET /rooms/:id/transcript` / `GET /rooms/:id/shared-manifest` / `GET /rooms/:id/shared?path=…` — 파일 요청은 `Authorization: Bearer <token>` 이 있고 방 멤버일 때만
  - 웹소켓: 첫 메시지 `{type: MSG.AUTH, token}`. 이후 `MSG` 의 요청 타입을 작업 2·3·4 함수에 연결하고, 실패는 `{type: MSG.ERROR, code}` 로 돌려준다
  - `run.finish` 에는 `{requestId, transcriptVersion, sessionId?, transcript, sharedChanges}` 가 오고, 파일 저장 → `queue.finish` 순서로 처리한다
  - 접속 중 사용자 목록을 `isOnline` 으로 넘기고, `setInterval(queue.tick, 5000)` 을 돈다
  - `run.approval {requestId, state: 'pending'|'resolved', toolName}` 을 받으면 방 전체에 그대로 방송한다("A 승인 대기 중" 표시용)
  - 웹소켓·HTTP 로 들어온 `roomId`·`repoId`·`requestId` 는 `Number()` 로 바꿔서 넘긴다(작업 2 함수는 `owner_id !== userId` 처럼 숫자로 비교한다)
  - `run.event`·`run.heartbeat`·`run.finish`·`run.fail`·`run.approval` 은 `queue.requesterOf(requestId)` 가 보낸 사람과 같을 때만 받는다(아니면 `FORBIDDEN`)
  - `room.leave` 는 `leaveRoom` 뒤에 `queue.onLeave` 를 부른다
  - `run.finish` 의 파일 쓰기는 `queue.finish` 의 `apply` 안에서 하고, 임시 파일에 쓴 뒤 `rename` 으로 확정한다(DB 롤백 때 파일은 되돌릴 수 없으므로)
  - `room.delete` 는 `deleteRoom` 뒤에 `data/rooms/<roomId>/` 폴더(대화 원본·공유 파일)도 지운다
  - `PORT` 기본 4310, `DATA_DIR` 기본 `server/data`
  - `npm start -w server` 로 시작

- [ ] **단계 1: 테스트 작성** — 서버를 임시 폴더와 빈 포트로 띄우고 웹소켓 클라이언트 둘(A, B)로: 가입 → A 방 만들기 → B 참가 → A 채팅 → B 가 같은 메시지를 받음. A `@claude` → A 클라이언트만 `run.start` 를 받음. 토큰 없는 파일 요청 401
- [ ] **단계 2: 구현**
- [ ] **단계 3: 실행** — `npm test -w server` → 통과. `npm start -w server` 후 `curl -s -XPOST localhost:4310/signup …` 응답에 token
- [ ] **단계 4: 사용자 확인 후 커밋** `feat: 서버 HTTP·웹소켓 연결`

---

### 작업 6: 앱 로컬 설정과 레포 점검

**파일:** 생성 `app/main/localConfig.js`, `app/main/runner/preflight.js`, 테스트 `app/test/preflight.test.js`

**인터페이스:**
- 쓰는 것: `normalizeRemote` (작업 2 — `shared/` 로 옮겨 같이 쓴다)
- 만드는 것:
  - `loadConfig() / saveConfig(cfg)` — `{serverUrl, token, rooms: {[roomId]: {repos: {[repoId]: localPath}}}}`, 위치 `~/.claude-rooms/config.json` (`ROOMS_HOME` 환경 변수로 바꿀 수 있음)
  - `checkRepo({localPath, remoteUrl, branch}) → {ok: boolean, block?: 'MISSING'|'REMOTE_MISMATCH'|'BRANCH_MISMATCH', warn: ('DIRTY'|'BEHIND')[]}` — `git -C`, `remote get-url origin`, `branch --show-current`, `status --porcelain`, `fetch` 후 `rev-list --count HEAD..@{u}`. `fetch` 실패는 경고 없이 넘어간다
  - `cloneRepo({remoteUrl, branch, name}) → localPath` — `~/.claude-rooms/repos/<name>` 에 `git clone --branch <branch>`
  - `preflight(roomRepos, roomConfig) → {ok, results: [{repoId, ...checkRepo 결과}]}`

- [ ] **단계 1: 테스트 작성** (임시 폴더에 bare 레포와 clone 을 만들어 사용) — 정상, 폴더 없음 `MISSING`, 원격 다름 `REMOTE_MISMATCH`, 브랜치 다름 `BRANCH_MISMATCH`, 수정 파일 있음 `warn: ['DIRTY']`, 원격이 한 커밋 앞섬 `warn: ['BEHIND']`, `cloneRepo` 후 지정 브랜치
- [ ] **단계 2: 구현** (`node:child_process` `execFile`)
- [ ] **단계 3: 실행** — `npm test -w app` → 통과
- [ ] **단계 4: 사용자 확인 후 커밋** `feat: 앱 로컬 설정과 레포 점검`

---

### 작업 7: 프롬프트 조립과 claude 실행

**파일:** 생성 `app/main/runner/prompt.js`, `app/main/runner/claude.js`, `app/test/fixtures/fake-claude.mjs`, `app/test/fixtures/stream-ok.jsonl`, `app/test/fixtures/stream-crash.jsonl`, 테스트 `app/test/claude.test.js`

**인터페이스:**
- 만드는 것:
  - `buildPrompt({chatsSince, requesterName, body}) → string` — 설계 6장 3번 형식. `chatsSince` 가 비면 `[방 대화]` 부분을 뺀다
  - `runClaude({cwd, prompt, sessionId, addDirs, systemPrompt, mcpConfigPath, onEvent, claudeBin = process.env.CLAUDE_BIN || 'claude'}) → Promise<{sessionId, exitCode}>` — 설계 6장 4번 인자 그대로. `sessionId` 가 없으면 `--resume` 을 빼고, 스트림의 `system/init` 에서 받은 ID 를 돌려준다. stdout 을 줄 단위로 JSON 파싱해 `onEvent` 로 넘기고, 파싱 안 되는 줄은 건너뛴다. 종료 코드가 0이 아니면 `Error('CLAUDE_EXIT_<code>')`, stderr 에 `usage limit` 이 있으면 `Error('USAGE_LIMIT')`
  - 자식 프로세스에 환경 변수를 그대로 넘긴다. 그래서 설계 10장 R4 에 따라 API 키로 바꿔야 하면 앱을 `ANTHROPIC_API_KEY` 를 넣고 실행하기만 하면 된다(별도 코드 없음)
  - `fake-claude.mjs`: 인자로 받은 fixture 파일을 한 줄씩 출력하고 지정한 코드로 끝나는 가짜 실행 파일

- [ ] **단계 1: 테스트 작성** — `buildPrompt` 결과 문자열 2개(대화 있음·없음), 가짜 claude 로 `stream-ok` → 이벤트 개수와 `sessionId`, `stream-crash`(종료 코드 1) → `CLAUDE_EXIT_1` 와 그때까지 받은 이벤트, `--resume` 인자 포함 여부. (선택) 실제 `claude` 가 있으면 `RUN_REAL_CLAUDE=1` 일 때만 짧은 실제 호출 1개
- [ ] **단계 2: 구현** (`node:child_process` `spawn`, `node:readline`)
- [ ] **단계 3: 실행** — `npm test -w app` → 통과
- [ ] **단계 4: 사용자 확인 후 커밋** `feat: 프롬프트 조립과 claude 실행`

---

### 작업 8: 권한 승인 다리

**파일:** 생성 `app/main/runner/approve.js`, `app/main/runner/approveMcp.js`, 테스트 `app/test/approve.test.js`

**인터페이스:**
- 쓰는 것: 작업 0 단계 4 에서 적어 둔 승인 도구 입력 모양
- 만드는 것:
  - `startApprovalBridge({askUser: (req) => Promise<'allow'|'deny'>}) → {port, mcpConfigPath, close()}` — `127.0.0.1` 임의 포트에 HTTP 를 열고, 임의 비밀값을 만들어 MCP 설정 파일(`mcpServers.rooms` = `node approveMcp.js`, env 에 포트·비밀값)을 임시 폴더에 쓴다
  - `approveMcp.js`: `approve` 도구 하나. 받은 `{tool_name, input}` 을 다리로 POST(비밀값 헤더 포함)하고, 답이 `allow` 면 `{"behavior":"allow","updatedInput":input}`, 아니면 `{"behavior":"deny","message":"사용자가 거부했습니다"}` 를 텍스트로 돌려준다
  - 비밀값이 틀린 요청은 403

- [ ] **단계 1: 테스트 작성** — 다리를 띄우고 SDK 클라이언트로 `approveMcp.js` 를 stdio 로 연결해 `approve` 호출: `askUser` 가 `allow` → allow 응답과 원래 input, `deny` → deny 응답. 비밀값 없는 POST 403
- [ ] **단계 2: 구현**
- [ ] **단계 3: 실행** — `npm test -w app` → 통과
- [ ] **단계 4: 사용자 확인 후 커밋** `feat: 권한 승인 다리`

---

### 작업 9: 대화 원본·공유 파일 동기화

**파일:** 생성 `app/main/runner/sync.js`, 테스트 `app/test/sync.test.js`

**인터페이스:**
- 쓰는 것: `safeJoin`(작업 4 — `shared/` 로 옮겨 같이 쓴다), 서버 HTTP(작업 5)
- 만드는 것:
  - `encodeProjectDir(absPath) → string` — 영숫자가 아닌 글자를 `-` 로 (작업 0 결과로 확정)
  - `transcriptPath({claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || ~/.claude, cwd, sessionId}) → string`
  - `pullRoom({http, roomId, roomDir, sessionId}) → {snapshot: Map<path, sha256>}` — 대화 원본을 `transcriptPath` 에 쓰고, 서버 `manifest` 와 로컬 `shared/` 를 비교해 다르거나 없는 파일만 받는다. 서버에 없는 로컬 파일은 지운다
  - `collectChanges({roomDir, snapshot}) → [{path, contentBase64 | null}]` — 실행 뒤 `shared/` 를 다시 훑어 바뀐 것·새것·지운 것
  - `readTranscript({cwd, sessionId}) → string`

- [ ] **단계 1: 테스트 작성** (가짜 http 객체, 임시 HOME) — `encodeProjectDir('/Users/a/claude-rooms/r1') === '-Users-a-claude-rooms-r1'`, pull 후 파일 위치와 내용, 실행 뒤 파일 1개 수정·1개 추가·1개 삭제 → `collectChanges` 3건, 서버 manifest 에 `../evil` 이 있으면 `BAD_PATH` 로 거부
- [ ] **단계 2: 구현**
- [ ] **단계 3: 실행** — `npm test -w app` → 통과
- [ ] **단계 4: 사용자 확인 후 커밋** `feat: 대화 원본·공유 파일 동기화`

---

### 작업 10: `@claude` 한 번 처리

**파일:** 생성 `app/main/runner/turn.js`, 테스트 `app/test/turn.test.js`

**인터페이스:**
- 쓰는 것: 작업 6~9 함수 전부, 서버 클라이언트의 `send(type, payload)`
- 만드는 것: `runTurn({runStart, roomState, roomConfig, client, http, askUser, claudeBin?}) → Promise<void>`
  순서: ① `preflight` — 막히면 `run.fail('PREFLIGHT:<코드>')` 하고 끝 ② `pullRoom` ③ `buildPrompt` ④ 방 메모리 목차(`shared/memory/INDEX.md`, 없으면 빈 문자열)를 `systemPrompt` 로 ⑤ 10초마다 `run.heartbeat` ⑥ `runClaude` (`addDirs` = 점검을 통과한 레포 경로 + `shared/`, 이벤트는 `run.event` 로) ⑦ 성공하면 `run.finish({transcriptVersion: runStart.transcriptVersion, sessionId, transcript, sharedChanges})` ⑧ 실패하면 `run.fail(에러 코드)` 만 보내고 대화 원본과 공유 파일은 올리지 않는다. 신호 타이머는 항상 멈춘다
  - `runClaude` 에는 항상 `permissionMode: 'default'` 를 넘긴다(설계 결정 15)
  - 레포 목록은 `runStart` 를 받은 시점의 `roomState` 로 고정한다
  - `askUser` 를 부르기 전에 `run.approval(pending)`, 답을 받은 뒤 `run.approval(resolved)` 를 보낸다
  - 승인 다리가 시간 초과(10분)로 거부한 뒤에도 화면의 승인 창은 남아 있으므로, 시간 초과·실행 종료 때 렌더러에 승인 창 닫기 신호를 보낸다

- [ ] **단계 1: 테스트 작성** (가짜 claude + 가짜 client) — 정상: 보낸 메시지 순서 `heartbeat…event…finish`, finish 에 공유 파일 변경 포함 / 브랜치 불일치: `run.fail('PREFLIGHT:BRANCH_MISMATCH')` 하나만, claude 실행 안 함 / 스트림 중 비정상 종료: `run.fail('CLAUDE_EXIT_1')`, `finish` 없음 / 실행 중 `roomState` 의 레포를 바꿔도 `addDirs` 는 시작 때 값
- [ ] **단계 2: 구현**
- [ ] **단계 3: 실행** — `npm test -w app` → 통과
- [ ] **단계 4: 사용자 확인 후 커밋** `feat: @claude 한 번 처리`

---

### 작업 11: Electron 메인과 서버 클라이언트

**파일:** 생성 `app/main/index.js`, `app/main/serverClient.js`, `app/main/preload.js`, 수정 `app/package.json`(`"main"`, `npm start` = `electron .`)

**인터페이스:**
- 쓰는 것: 작업 6~10
- 만드는 것:
  - `createServerClient({serverUrl, token}) → {send(type, payload), on(type, fn), http: {get(path), post(path, body)}, close()}` — 끊기면 1·2·4·8초(최대 8초) 간격으로 다시 연결한다
  - `claudeAuthStatus() → {loggedIn, email?, orgName?, subscriptionType?}` — `claude auth status` 의 JSON 출력을 읽는다. `claudeLogin() → Promise<void>` — `claude auth login` 을 실행하고 끝날 때까지 기다린다. 둘 다 `preload.js` 에 노출
  - 메인: 창 1개(`contextIsolation: true`, `nodeIntegration: false`). `run.start` 를 받으면 `runTurn` 을 부르고, `askUser` 는 렌더러에 승인 창을 띄워 답을 기다린다
  - `preload.js` 가 `window.rooms` 로 노출: `signup, login, listRooms, createRoom, joinRoom, leaveRoom, openRoom(roomId), sendMessage(roomId, text), retry(requestId), repo.add/update/remove, room.rename/regenerateInvite/delete, linkRepo(roomId, repoId, localPath), cloneRepo(roomId, repoId), pickFolder(), readShared(roomId, path), onEvent(fn), answerApproval(id, 'allow'|'deny')`

- [ ] **단계 1: 구현**
- [ ] **단계 2: 확인** — 서버를 켜고 `npm start -w app` → 창이 뜨고, 개발자 도구 콘솔에서 `await window.rooms.signup({...})` 가 token 을 돌려준다
- [ ] **단계 3: 사용자 확인 후 커밋** `feat: Electron 메인과 서버 클라이언트`

---

### 작업 12: 화면 (토스 분위기)

**파일:** 생성 `app/renderer/index.html`, `tokens.css`, `app.js`, `views/login.js`, `views/roomList.js`, `views/room.js`, `views/settings.js`, `views/approvalModal.js`

**정할 값:**
- 토큰(`tokens.css`, `:root` 와 `@media (prefers-color-scheme: dark)`): 배경 `#FFFFFF` / `#17171C`, 카드 `#F2F4F6` / `#202027`, 본문 글자 `#191F28` / `#ECECEF`, 보조 글자 `#8B95A1`, 강조 `#3182F6`, 실패 `#F04452`, 모서리 16px(카드)·12px(버튼), 간격 4의 배수, 글꼴 Pretendard(`index.html` 에서 CDN 링크), 제목 24px 굵게, 본문 15px
- 화면 구성은 설계 7.2장 그대로. 화면 아래 큰 기본 버튼(높이 56px, 강조색, 가로 가득)
- Claude 답은 `marked` 로 md 를 그리고, 도구 실행 이벤트는 접힌 한 줄("파일 읽음: a.js")로 보여 준다
- `@claude` 요청 배지 문구: 대기 / 실행 중 / 완료 / 실패 / 보류, `failed`·`held` 에는 [다시 보내기]
- [레포] 탭: 레포마다 경로, 브랜치, 막힘·경고 문구와 [폴더 고르기]·[clone] 버튼
- [공유 파일] 탭: `.md` 는 `marked` 로, `.html` 은 `sandbox` 를 건 `iframe` 으로 미리보기
- 승인 창: "<도구 이름>" 과 입력 요약, [거부]·[허용] 두 버튼
- **화면 보안**(화면은 `window.rooms.answerApproval` 같은 강한 함수를 부를 수 있으므로, 남이 쓴 글이 화면 코드로 실행되면 안 된다):
  - 채팅·Claude 답·파일 이름 등 서버에서 온 글은 전부 `textContent` 로 넣는다. `innerHTML` 은 `marked` 결과에만 쓰고, `marked` 는 원문 HTML 을 이스케이프하도록 설정한다(`renderer.html` 을 이스케이프로 교체). 링크는 `http:`·`https:` 만 남긴다
  - `index.html` CSP 는 `default-src 'self'` 를 유지한다(외부 CDN 금지). Pretendard 글꼴은 npm 패키지(`pretendard`)의 woff2 를 앱 안에 넣어 쓴다
  - HTML 아티팩트 미리보기 `iframe` 은 `sandbox=""`(스크립트·same-origin 모두 금지) + `srcdoc`
- 방 목록 위에 Claude 로그인 상태 한 줄(계정·플랜). 로그인 안 됨이면 [Claude 로그인] 버튼, 그 사이 `@claude` 입력은 막고 사람 채팅만 허용

- [ ] **단계 1: 구현**
- [ ] **단계 2: 확인** — 라이트·다크 둘 다 로그인 → 방 만들기 → 채팅 → 방 설정까지 화면 캡처를 남긴다
- [ ] **단계 3: 사용자 확인 후 커밋** `feat: 앱 화면`

---

### 작업 13: 맥 두 대 시나리오 확인

**파일:** 결과를 설계 문서 11장 아래에 "확인 결과"로 적는다.

- [ ] **단계 1:** 맥1 에서 서버를 띄우고 두 맥에서 앱을 실행한다. 맥2 의 서버 주소는 `http://<맥1 IP>:4310`
- [ ] **단계 2:** 설계 11장 수동 시나리오 ①~⑧ 을 차례로 하고 각각 통과·실패와 화면 캡처를 남긴다
- [ ] **단계 3:** 실패 항목을 정리해 사용자와 다음 조치를 정한다
