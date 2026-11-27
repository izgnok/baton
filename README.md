# Claude Rooms

서로 다른 Claude 계정을 쓰는 사람들이 같은 채팅방에서 같은 Claude 대화를 이어 가는 맥 앱과 중계 서버.
Claude 에게 보낸 요청은 보낸 사람의 맥에서, 그 사람의 Claude Code 로그인(구독)으로 실행된다.
설계·구현 계획·UI 점검표·화면 캡처는 `docs/`.

## 준비

- macOS 14 이상, Command Line Tools(`swift`·`git`, Xcode 는 필요 없음), Node 24 이상
- Claude 에게 요청하려면 Claude Code CLI(`claude`)에 유료 플랜(Pro 이상)으로 로그인돼 있어야 한다

```bash
git clone https://github.com/izgnok/claude-rooms.git ~/claude-rooms
```

```bash
cd ~/claude-rooms && npm install && npm run mac
```

`npm run mac` 이 `~/Applications/Claude Rooms.app` 을 만든다(SwiftPM 없이 `swiftc` 로 빌드). Dock·Spotlight 에서 연다.
앱은 이 소스 폴더의 Node 코어(`app/main/core.js`)를 띄워 쓰므로, 소스 폴더는 지우지 않는다.

## 서버

방·메시지·공유 파일을 보관하는 서버는 **한 맥에서만** 켠다. 두 방법 중 하나:

- 앱 설정(⌘,)의 **[이 맥에서 서버 실행]** 스위치. 앱을 완전히 종료(⌘Q)하면 서버도 꺼진다. 설정 창에 다른 맥에서 접속할 주소가 나온다.
- 터미널에서 따로:

```bash
npm start -w server
```

관리 프로그램이 서버를 띄우고, 30분마다 `origin/main` 에 새 커밋이 있으면 실행 중인 Claude 요청이 끝난 뒤 받아서 다시 시작하며, 서버가 죽으면 다시 띄운다(1분에 5번 넘게 죽으면 멈춤). 관리 프로그램 없이 서버만은 `npm run start:raw -w server`.
시작 로그의 `LAN: http://<IP>:4310` 이 다른 맥에서 접속할 주소다. `PORT`, `DATA_DIR` 환경 변수로 바꿀 수 있다.

## 사용

- 로그인 화면의 서버 주소에 위 주소를 넣고 가입·로그인한다. 앱 데이터(설정·방 폴더·방 작업 폴더·공유 파일 사본)는 `~/.claude-rooms` 에 생긴다.
- 방장이 레포를 추가하면 각자 맥에서 같은 레포를 자동으로 찾아 연결한다(없으면 [clone 받기]). Claude 는 방 전용 작업 폴더(git worktree)에서 방 브랜치 기준으로 일하고, 내 원본 폴더는 건드리지 않는다.
- 업데이트: 새 커밋이 있으면 화면 위 띠의 [업데이트] 를 누른다(`git pull` → 필요하면 `npm install` → `mac/` 이 바뀌었으면 앱 다시 빌드 → 다시 켜기). 방 목록의 [업데이트 확인] 으로 바로 확인할 수도 있다.

한 맥에서 앱을 두 개 띄워 시험하려면 두 번째 앱에 데이터 폴더를 따로 준다:

```bash
ROOMS_HOME=~/.claude-rooms-b "$HOME/Applications/Claude Rooms.app/Contents/MacOS/ClaudeRooms"
```

## 테스트

```bash
npm test
```

```bash
npm run test:mac
```

- `npm test` — 서버·코어(Node) 테스트, `npm run test:mac` — 맥 앱 로직(Swift Testing)
- `cd app && node main/core.js --smoke` — 서버·연결·승인 도구가 도는지 창 없이 점검
- `ROOMS_HOME=$(mktemp -d) ROOMS_SCREENSHOT=<폴더> "$HOME/Applications/Claude Rooms.app/Contents/MacOS/ClaudeRooms"` — 가짜 데이터로 화면 캡처 21장

Electron 앱(`npm start -w app`, `npm run host`)은 맥 앱 전환 확인이 끝나면 지운다.
