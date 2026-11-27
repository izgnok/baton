# Baton 이름·디자인 구현 계획

> 실행: 메인(Opus)이 작업마다 sonnet-worker 에 맡기고 diff 를 검토한다(`~/.claude/rules/claude-workflow.md`). 단계마다 사용자 확인 뒤 커밋.

**목표:** 앱 이름을 Claude Rooms → Baton 으로 전부 바꾸고, 화면을 "차분한 노트" 스타일로 바꾼다.

**구조:** 이름 바꾸기(Task 1~4, 커밋 1개)를 먼저 끝낸 뒤 디자인(Task 5~8, 커밋 1개). GitHub 레포 이름은 마지막(Task 9, 사용자 확인 뒤 메인이 직접).

**기술:** Node 24 코어(`app/`·`server/`·`shared/`), Swift 6 + SwiftUI 맥 앱(`mac/`, swiftc 직접 빌드), 외부 라이브러리 추가 없음.

**설계:** `docs/2026-11-27-baton-design.md` (실행자는 이 문서와 함께 읽는다)

**시작 조건:** 공유 사본 3단계(앱 연결)가 커밋된 뒤.

## 공통 제약

- 이름: 앱 `Baton`, 번들 ID `dev.baton.app`, 데이터 폴더 `~/.baton`(env `BATON_HOME`), env 접두사 `BATON_`, npm 루트 `baton`·스코프 `@baton/`, Info.plist 키 `BatonSource`·`BatonCommit`, Swift 모듈 `Baton`·`BatonKit`.
- 그대로: 서버 메시지 이름(`room.*`, `rooms.changed`, `MSG.ROOMS_CHANGED`), git 이름표 `refs/rooms/…`, UserDefaults 키 `rooms.mode.*`, 기능 이름 "방".
- 색은 `Theme.swift` 의 이름 있는 색으로만(화면 코드에 hex 금지). 버튼 높이 36/28/24/텍스트, 글자 20/16/15/13/12 유지.
- 공개 레포: 회사 이름·사내 주소·실제 계정 정보 금지.
- 테스트는 임시 폴더만. 이 맥의 실제 `~/.claude-rooms`·`server/data`·서버 4310 은 건드리지 않는다.

## 리뷰 초점

1. `~/.baton` 과 `~/.claude-rooms` 가 둘 다 있을 때 → 아무것도 옮기지 않고 `~/.baton` 사용(Task 1 테스트).
2. 옛 앱(Claude Rooms)이 업데이트로 새 소스를 빌드한 뒤 다시 켜기 → 옛 번들 경로가 사라져도 Baton.app 이 떠야 함(Task 3: 옛 경로에 심볼릭 링크).
3. 이전 중 원본 레포가 없어졌거나 옮겨진 방 작업 폴더 → `worktree repair` 실패해도 이전은 성공, 로그만(Task 1 테스트).
4. `BATON_HOME` 을 준 실행(테스트·캡처) → 이전하지 않음(Task 1 테스트).
5. 어두운 모드에서 보조 글자·포인트 버튼 글자 대비 4.5:1 미만 → 캡처 점검에서 걸러야 함(Task 8).

---

### Task 1: 데이터 폴더·환경 변수

**Files:**
- Modify: `app/main/localConfig.js:6-8`(roomsHome → `batonHome()`, `BATON_HOME`, `~/.baton`; 부르는 곳 전부 이름 변경)
- Create: `app/main/migrateHome.js`
- Modify: `app/main/core.js`(service 만들기 전에 이전 호출)
- Modify: `ROOMS_*` env 를 쓰는 모든 JS·Swift(`git grep -n "ROOMS_[A-Z]"` — `MSG.ROOMS_CHANGED` 제외)
- Test: `app/test/migrateHome.test.js`

**Interfaces:**
- Produces: `migrateHome({ home, oldHome, env = process.env, isOldAppRunning }) → Promise<{ moved: boolean, reason?: 'HOME_SET'|'NO_OLD'|'BOTH_EXIST'|'OLD_RUNNING'|'FAILED', repaired: number }>`
  - `env.BATON_HOME` 있으면 HOME_SET. oldHome 없으면 NO_OLD. home 이미 있으면 BOTH_EXIST. `isOldAppRunning()`(기본: `pgrep -x ClaudeRooms` 결과 있음) 이면 OLD_RUNNING.
  - `fs.renameSync(oldHome, home)` → `home/*/repos/*` 중 `.git` 파일이 있는 폴더마다 `git -C <폴더> worktree repair`(실패는 세고 넘어감). rename 실패면 FAILED, 아무것도 안 바꿈.
  - core.js 는 결과를 `core.log` 에 한 줄.
- env 이름 매핑: `ROOMS_HOME→BATON_HOME, ROOMS_SCREENSHOT→BATON_SCREENSHOT, ROOMS_NO_BACKGROUND→BATON_NO_BACKGROUND, ROOMS_SERVER_PORT→BATON_SERVER_PORT, ROOMS_EXIT_WITH_PARENT→BATON_EXIT_WITH_PARENT, ROOMS_READ_REPOS→BATON_READ_REPOS, ROOMS_APP_COMMIT→BATON_APP_COMMIT, ROOMS_APPROVE_SECRET→BATON_APPROVE_SECRET, ROOMS_APPROVE_PORT→BATON_APPROVE_PORT, ROOMS_SMOKE→BATON_SMOKE, ROOMS_SOURCE→BATON_SOURCE`.

- [ ] **Step 1: 테스트** — 임시 home 에서
  - `옛 폴더만 있으면 옮기고 방 작업 폴더의 원본 쪽 등록이 새 경로`: oldHome 에 원본 레포의 worktree(`<oldHome>/1/repos/5-api`)를 만든 뒤 이전 → `moved:true, repaired:1`, 원본에서 `git worktree list --porcelain` 에 새 경로가 있고 옛 경로가 없음
  - `둘 다 있으면 BOTH_EXIST, 옛 폴더 그대로`
  - `BATON_HOME 이 있으면 HOME_SET`
  - `옛 앱이 켜져 있으면 OLD_RUNNING`
  - `원본 레포가 지워진 작업 폴더가 있어도 moved:true, repaired:0`
- [ ] **Step 2:** `node --test app/test/migrateHome.test.js` → 실패 확인
- [ ] **Step 3:** migrateHome.js·localConfig·core 구현, env 이름 일괄 변경(JS·Swift·README 의 실행 예시)
- [ ] **Step 4:** `npm test` 전체 통과 + `git grep -nE "ROOMS_[A-Z]" | grep -v ROOMS_CHANGED` 결과 없음

### Task 2: npm 패키지 이름

**Files:** `package.json`(name `baton`), `shared/package.json`·`app/package.json`·`server/package.json`(`@rooms/*` → `@baton/*`), import 하는 모든 파일, `package-lock.json`(npm install 로 다시 만듦)

- [ ] **Step 1:** 이름 변경 후 `npm install` → `node_modules/@baton/shared` 생김, `node_modules/@rooms` 없음
- [ ] **Step 2:** `npm test` 전체 통과 + `git grep -n "@rooms/"` 결과 없음
- (앱 안 업데이트는 lock 이 바뀌면 npm install 을 돌리므로 다른 맥도 자동으로 맞춰진다 — `app/main/updater.js:67`)

### Task 3: Swift 앱 이름·번들

**Files:**
- 폴더 이름: `mac/Sources/ClaudeRooms` → `mac/Sources/Baton`, `mac/Sources/RoomsKit` → `mac/Sources/BatonKit`, `mac/Tests/RoomsKitTests` → `mac/Tests/BatonKitTests`(`git mv`)
- Modify: `mac/build.sh`(모듈 `Baton`, 실행 파일 `Baton`, `Baton.app`, CFBundleName/DisplayName `Baton`, ID `dev.baton.app`, 키 `BatonSource`·`BatonCommit`), `mac/test.sh`(BatonKit), `import RoomsKit` → `import BatonKit`, `AppModel.swift:131,190`(키·env 이름), 타입 이름 `RoomsButtonStyle`→`BatonButtonStyle`·`.rooms(`→`.baton(`
- Modify: 화면 문구 "Claude Rooms" → "Baton"(Swift·JS·capture 가짜 데이터)

**Interfaces:**
- build.sh 설치 단계: `~/Applications/Baton.app` 설치 뒤, `~/Applications/Claude Rooms.app` 이 실제 폴더면 지우고 그 자리에 `Baton.app` 을 가리키는 심볼릭 링크를 만든다(옛 앱의 다시 켜기 `open -n "<옛 번들 경로>"` 가 새 앱을 띄우게).
- Baton 앱이 켜질 때 `~/Applications/Claude Rooms.app` 이 심볼릭 링크면 지운다(`App.swift` 시작 시, 캡처 모드 제외).

- [ ] **Step 1:** `npm run test:mac` 통과(이름만 바뀐 같은 테스트 수)
- [ ] **Step 2:** `npm run mac` 경고 0, `~/Applications/Baton.app` 생김, `defaults read ~/Applications/Baton.app/Contents/Info CFBundleIdentifier` = `dev.baton.app`
- [ ] **Step 3:** 임시 폴더에 가짜 `Claude Rooms.app`(폴더)을 둔 상태로 설치 단계만 돌리는 방법이 없으면 build.sh 의 설치 부분을 함수로 떼어 `DEST_DIR` env 로 임시 폴더를 받게 하고 확인: 옛 앱 폴더 → 링크로 바뀜
- [ ] **Step 4:** `git grep -n "Claude Rooms\|ClaudeRooms\|RoomsKit\|RoomsSource\|RoomsCommit\|dev.claude-rooms"` → 문서의 "옛 이름" 설명 외 결과 없음

### Task 4: 문서·README

**Files:** `README.md`, `docs/user-guide.md`(설치 명령 `git clone https://github.com/izgnok/baton.git ~/baton`, 앱 이름, 데이터 폴더·로그 경로 `~/.baton/core.log`·`server.log`), 다른 docs 는 앱 이름이 현재 상태를 말하는 곳만(과거 기록인 설계·계획 문서 본문은 그대로)

- [ ] **Step 1:** 사용자 가이드 "문제가 생기면" 표에 "업데이트 뒤 앱 이름이 Baton 으로 바뀌어요 — Spotlight 에서 Baton" 한 줄
- [ ] **Step 2:** 메인이 diff 검토 → 이름 바꾸기 커밋(Task 1~4 묶음, 사용자 승인 뒤)

### Task 5: 색·모양 기준(Theme)

**Files:** `mac/Sources/Baton/Theme.swift`(색·모서리·버튼·카드·입력칸), `mac/Sources/Baton/Fonts.swift` 또는 Theme 의 Typo(제목 세리프)

**Interfaces:**
- 색 이름은 지금 Theme 의 역할 이름을 유지하고 값만 설계 2.1 로 바꾼다. 대응: `bg`=바탕, `card`=카드(`#FFFDF8`/`#2A2926`), 새 `panel`=패널(`#EFEADF`/`#232220`), `line`=선, `text`=글자, `sub`=보조, `primary`·`accent`·`accentText`=포인트(`#2F6F5E`/`#6FB59E`), 새 `onPrimary`=포인트 위 글자(`#F6F3EC`/`#1C1B19`), `mine`=내 말 상자(`#2F6F5E`), `dangerText`·`warnText`=경고(`#B4532A`/`#E08A5F`). `accentSoft`·`warnSoft`·`segOn`·`cardButton`·`usageTrack` 은 설계 표의 바탕·패널·카드·선 중 가장 가까운 값으로.
- 모서리 상수 하나 `Theme.radius = 4`, 버튼·카드·입력칸 모두 사용(`cornerRadius: 8/12` 를 이걸로). 그림자 제거.
- `Typo.title` 계열(20·16 중 화면·방 제목) 에 `.system(size:, weight:, design: .serif)`. 본문은 Pretendard 그대로.
- 탭: 선택 탭 글자 굵게 + `Theme.primary` 밑줄 2px.

- [ ] **Step 1:** `npm run mac` 경고 0
- [ ] **Step 2:** 캡처(`BATON_HOME=$(mktemp -d) BATON_SCREENSHOT=<폴더> ~/Applications/Baton.app/Contents/MacOS/Baton`) 밝게·어둡게 02·03·07 확인

### Task 6: 채팅 모양

**Files:** `mac/Sources/Baton/Views/Room/MessageViews.swift`, `ChatView.swift`(필요한 곳만)

- 내 말: `Theme.mine` 상자 + `Theme.onPrimary` 글자(어둡게는 `#F0ECE2` — Theme 에 `onMine`), 모서리 4.
- 남의 말: `Theme.card` + `Theme.line` 테두리, 위에 사람별 이름 색.
- Claude 답: 상자 없이 왼쪽 2px `Theme.primary` 세로줄 + 위 머리표 "CLAUDE"(12, 자간 0.06em 근사 `.tracking(0.7)`, `Theme.primary`). 진행 표시·서브에이전트·diff 카드는 `Theme.card` + `Theme.line`.
- 사람별 이름 색 팔레트를 두 모드에서 바탕 대비 4.5:1 이상인 값으로 다시 정한다(`BatonKit` 에 팔레트가 있으면 그 테스트에 대비 계산 테스트 추가: 각 색 vs `#F6F3EC`·`#1C1B19` 대비 ≥ 4.5).

- [ ] **Step 1:** `npm run test:mac` 통과(대비 테스트 포함)
- [ ] **Step 2:** 캡처 03·03b·03c 밝게·어둡게 확인

### Task 7: 앱 아이콘

**Files:**
- Create: `mac/Resources/icon.svg`(설계 2.5 — 카드색 둥근 사각형 + 진녹 바통: 기울인 둥근 막대 + 끝 점), `mac/scripts/icon.swift`
- Modify: `mac/build.sh`(아이콘 생성 → `Contents/Resources/AppIcon.icns`, Info.plist `CFBundleIconFile` = `AppIcon`)

**Interfaces:**
- `swift mac/scripts/icon.swift <svg> <out.iconset>` → 16·32·128·256·512 와 @2x PNG. `NSImage(contentsOf: svg)` 로 그린다. SVG 를 못 읽으면 같은 도형을 NSBezierPath 로 그린다(스크립트 안에 둠). 그 뒤 `iconutil -c icns`.
- 생성물은 `.build/` 아래에만(레포에 PNG·icns 커밋 안 함).

- [ ] **Step 1:** `npm run mac` 뒤 `~/Applications/Baton.app/Contents/Resources/AppIcon.icns` 존재, `sips -g pixelWidth` 로 1024 포함 확인
- [ ] **Step 2:** Finder 에서 아이콘이 보이는지 메인이 스크린샷으로 확인

### Task 8: 캡처 교체·대비 점검·디자인 커밋

**Files:** `docs/screens-2026-11-26/*.png`(새 캡처로 교체 — 폴더 이름은 그대로), `docs/2026-11-27-ui-review.md`(색 표를 설계 2.1 로 갱신, 5장 2번 "주 버튼 #1B64DA" 결정이 Baton 설계로 바뀌었다는 한 줄)

- [ ] **Step 1:** 21장 캡처, 메인이 밝게·어둡게 대표 장면 확인
- [ ] **Step 2:** 대비 점검: 본문(`text` vs `bg`), 보조(`sub` vs `bg`·`panel`), 주 버튼 글자(`onPrimary` vs `primary`) — 두 모드 모두 4.5:1 이상인지 계산(작은 스크립트, 결과를 커밋 메시지 본문에)
- [ ] **Step 3:** `npm test`·`npm run test:mac` 통과 → 디자인 커밋(사용자 승인 뒤)

### Task 9: GitHub 레포 이름 (메인 직접, 사용자 확인 뒤)

- [ ] **Step 1:** 사용자 확인 → `gh repo rename baton -R izgnok/claude-rooms`(샌드박스 해제), `git remote set-url origin https://github.com/izgnok/baton.git`
- [ ] **Step 2:** 옛 주소로 `git ls-remote` 가 넘겨 받아지는지 확인(맥2 의 기존 clone 이 그대로 pull 되는지)
- [ ] **Step 3:** 맥2 업데이트 확인표: 업데이트 → Baton.app 으로 바뀜, 방·대화·사본 그대로, `~/.baton` 으로 옮겨짐
