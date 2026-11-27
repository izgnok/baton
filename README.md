# Claude Rooms

서로 다른 Claude 계정을 쓰는 사람들이 같은 채팅방에서 같은 Claude 대화를 이어 가는 데스크톱 앱과 중계 서버.
`@claude` 요청은 보낸 사람의 맥에서, 그 사람의 Claude Code 로그인으로 실행된다.
설계·구현 계획·화면 캡처는 `docs/`.

## 준비

- Node 24 이상, git
- `@claude` 를 쓰려면 Claude Code CLI(`claude`)에 유료 플랜(Pro 이상)으로 로그인돼 있어야 한다

```bash
npm install
```

앱 실행 때 `Electron failed to install correctly` 가 나오면 Electron 본체를 한 번 받는다:

```bash
node node_modules/electron/install.js
```

## 실행

서버(한 대에서만). 관리 프로그램이 서버를 띄우고, 30분마다 `origin/main` 에 새 커밋이 있으면 실행 중인 Claude 요청이 끝난 뒤 받아서 다시 시작하고, 서버가 죽으면 다시 띄운다:

```bash
npm start -w server        # 관리 프로그램(자동 업데이트·재시작)
npm run start:raw -w server  # 관리 프로그램 없이 서버만
```

시작 로그의 `LAN: http://<IP>:4310` 이 다른 맥에서 접속할 주소다. `PORT`, `DATA_DIR` 환경 변수로 바꿀 수 있다.
소스 폴더에 커밋 안 된 변경이 있으면 자동 업데이트는 건너뛰고 경고만 낸다. 앱도 같은 방식으로 새 커밋을 알려 주고 화면 위 띠의 [업데이트] 로 받는다.

앱:

```bash
npm start -w app
```

로그인 화면의 서버 주소에 위 주소를 넣는다. 앱 데이터(설정·방 폴더·clone 한 레포)는 `~/.claude-rooms` 에 생긴다.
한 맥에서 앱을 두 개 띄워 시험하려면 두 번째 앱에 데이터 폴더를 따로 준다:

```bash
ROOMS_HOME=~/.claude-rooms-b npm start -w app
```

## 테스트

```bash
npm test
```

- `ROOMS_SMOKE=1 npm start -w app` — 창 없이 서버·연결·승인 서버가 Electron 안에서 도는지 점검
- `ROOMS_SCREENSHOT=<폴더> npm start -w app` — 가짜 데이터로 화면 캡처
