# Claude Rooms 맥 앱(Swift) 구현 계획

> 실행: 사용자 작업 규칙(`claude-workflow.md`)을 따른다 — 메인이 구조·통합·검토, 범위가 분명한 화면 조각은 `sonnet-worker` 에 위임하고 메인이 diff 를 확인한다. 단계마다 사용자 확인 뒤 커밋(AI 표시 없음). 체크박스(`- [ ]`)로 진행을 적는다.

**Goal:** Electron 화면을 SwiftUI 맥 앱으로 바꾸고, 지금 `app/main` 로직은 Node 코어 프로세스로 재사용한다.

**Architecture:** `Claude Rooms.app`(SwiftUI)이 `node app/main/core.js` 를 자식으로 띄우고 stdin/stdout 한 줄 JSON 으로 40개 기능·6개 알림을 주고받는다. 맥 기능(폴더 고르기·열기·다시 실행·서버 호스트)은 Swift 가 한다. 서버는 그대로.

**Tech Stack:** Swift 6.4 / `swiftc` 직접 빌드(Command Line Tools, Xcode·SwiftPM 없음 — 설계 S4), Swift Testing, SwiftUI(macOS 14+), WKWebView, Node 24(ESM, node:test). 외부 Swift 라이브러리 없음.

**Spec:** `docs/2026-11-27-swift-app-design.md`

## Global Constraints

- 서버(`server/`)·웹소켓 프로토콜은 바꾸지 않는다.
- 코어 기능 이름·인자·결과는 `app/main/preload.cjs` 목록 그대로. 예외는 설계 3장(`pickFolder` 는 Swift, `openFolder`/`openShared` 는 경로 반환).
- 코어 stdout 은 통신 전용. 로그는 stderr.
- 최소 macOS 14, 빌드는 `mac/build.sh`·`mac/test.sh`(swiftc, Xcode·SwiftPM 금지), 번들 ID `dev.claude-rooms.app`, 실행 파일 이름 `ClaudeRooms`, 설치 위치 `~/Applications/Claude Rooms.app`.
- 이 맥의 CLT 에는 SwiftUI 매크로 플러그인(SwiftUIMacros)이 없어 `@State` 가 컴파일되지 않는다 → `Theme.swift` 의 `typealias Local<V> = State<V>` 로 `@Local` 을 쓴다(`@Observable`·`@FocusState` 는 됨)
- 공개 레포: 회사 이름·사내 주소·계정 정보를 코드·테스트·문서에 넣지 않는다.
- 화면 문구·색·간격·버튼 크기는 Task 4b 의 UI 점검표(`docs/2026-11-27-ui-review.md`)에서 정한 기준을 따른다. 점검표에 없는 것은 지금 Electron 화면(`app/renderer/**`, `tokens.css`·`app.css`)을 따른다. 글꼴 Pretendard(Regular·Medium·SemiBold·Bold OTF).
- 단계마다 `npm test`(서버·앱)와 `npm run test:mac` 이 통과해야 커밋한다.

## Review Focus

1. 의존 라이브러리나 코드 어딘가의 `console.log` 가 stdout 에 섞임 → 통신이 깨지면 안 된다(Task 1 테스트).
2. 한 줄이 여러 조각으로 오고 한글(멀티바이트)이 조각 경계에서 잘림 → Swift 가 줄을 온전히 다시 붙여야 한다(Task 4 테스트).
3. Dock 에서 켜서 PATH 에 Homebrew 가 없음 → node 를 로그인 셸·고정 경로 순으로 찾고, 없으면 안내 화면(Task 4 테스트).
4. 코어가 계속 죽음 → 1분에 3번까지만 다시 띄우고 멈춤(Task 4 테스트).
5. 업데이트 중 Swift 빌드 실패 → 지금 앱을 그대로 두고 "빌드 실패" 알림, 다시 켜지 않음(Task 11 테스트).

---

### Task 1: 코어 stdio 통신 모듈 (Node)

**Files:**
- Create: `app/main/stdio.js`
- Test: `app/test/stdio.test.js`

**Interfaces:**
- Produces: `createStdioServer({ input: Readable, output: Writable, handlers: Record<string, (args) => any>, onEnd?: () => void, log?: (msg) => void }) → { emit(event: string, payload: any): void, setHandler(name, fn): void }`
  - 줄 `{"id","call","args"}` → `{"id","ok":true,"data"}` / `{"id","ok":false,"error"}`. error 는 `e.message`. 없는 call 은 `UNKNOWN_CALL`. JSON 이 아니거나 id 가 없으면 무시하고 log.
  - `emit` → `{"event","payload"}` 한 줄. `data`/`payload` 가 undefined 면 `null`.
  - input 이 끝나면 `onEnd()`.

- [ ] **Step 1: 테스트** — PassThrough 로 입력·출력을 만들고:
  - `stdio: 요청에 같은 id 로 ok/data 응답` — `{"id":1,"call":"echo","args":{"a":"한글"}}` → `{"id":1,"ok":true,"data":{"a":"한글"}}`
  - `stdio: 처리기 오류는 ok:false error 코드` — throw `new Error('NOT_FOUND')` → `error:"NOT_FOUND"`; 없는 call → `UNKNOWN_CALL`
  - `stdio: 잘못된 줄은 무시하고 다음 줄은 처리` — `"not json\n"` 뒤 정상 요청에 응답 1개
  - `stdio: 두 줄이 한 조각, 한 줄이 두 조각으로 와도 처리`
  - `stdio: emit 은 event/payload 한 줄`
  - `stdio: 입력이 끝나면 onEnd 호출`
- [ ] **Step 2:** `cd app && node --test test/stdio.test.js` → 실패 확인
- [ ] **Step 3:** 구현(`node:readline` 의 `createInterface({ input })` 로 줄 단위)
- [ ] **Step 4:** 테스트 통과
- [ ] **Step 5:** 사용자 확인 뒤 커밋 `feat: 코어 stdio 통신 모듈`

### Task 2: 로직을 Electron 과 분리 — `service.js` + `core.js`

**Files:**
- Create: `app/main/service.js` — `index.js` 의 상태(config·client·roomCache·pending·runs·runningRooms·updater·sharedSync…)와 함수·`handlers` 를 옮긴다
- Create: `app/main/core.js` — 코어 진입점
- Modify: `app/main/index.js` — Electron 껍데기만 남김(service 사용)
- Test: `app/test/core.test.js`

**Interfaces:**
- Consumes: Task 1 `createStdioServer`
- Produces:
  - `createService({ emit: (event, payload) => void, relaunch: () => void }) → { handlers, start({ capture?: boolean }): Promise<void>, stop(): void }`
    - `handlers` = 지금 handlers 에서 `pickFolder` 를 뺀 것. `openFolder({path})` → 검사 후 `{ path }` 반환(열지 않음). `openShared({roomId, path?, reveal?})` → `{ path, reveal }` 반환. 실패 코드는 지금과 같음(`FORBIDDEN`/`NOT_FOUND`).
    - `getConfig()` 결과에 `hostServer: boolean`(config.json `hostServer`, 기본 false) 추가. 새 처리기 `setHostServer({ on: boolean })`.
    - `toRenderer(channel, payload)` 는 `emit(channel, payload)` 로, 업데이트 다시 켜기는 `relaunch()` 로.
  - `core.js`: 맨 앞에서 `console.log = console.info = console.error`(stdout 보호) → `fixPath()` → `createService({ emit, relaunch: () => emit('relaunch', null) })` → `createStdioServer({ input: process.stdin, output: process.stdout, handlers: service.handlers, onEnd: () => { service.stop(); process.exit(0); } })`. 인자 `--smoke` 면 지금 `smoke()` 를 Node 에서 돌려 결과 JSON 을 stdout 에 한 줄 쓰고 종료(smoke 는 service.js 로 옮김).
  - Electron `index.js`: `createService({ emit: toRenderer, relaunch: app.relaunch+exit })`, `ipcMain.handle` 로 등록하면서 `openFolder`→`shell.openPath`, `openShared`→`reveal ? shell.showItemInFolder : shell.openPath`, `pickFolder`→`dialog` 를 감싼다(전환 기간용).

- [ ] **Step 1: 테스트** `app/test/core.test.js` — `spawn(process.execPath, ['main/core.js'], { env: { ...process.env, ROOMS_HOME: tmp } })`:
  - `core: getConfig 응답 — 새 홈이면 loggedIn false, hostServer false`
  - `core: setHostServer 뒤 getConfig.hostServer true, config.json 에 저장`
  - `core: 처리기 안의 console.log 가 stdout 을 깨지 않는다` — 응답 줄이 전부 JSON.parse 되는지(Review Focus 1)
  - `core: stdin 을 닫으면 3초 안에 종료(코드 0)`
  - `core: --smoke 가 ok:true 를 낸다`(claude 로그인이 없는 환경이면 해당 단계만 실패 허용 — 지금 SMOKE 판정 규칙 그대로)
- [ ] **Step 2:** 실패 확인
- [ ] **Step 3:** 옮기기. 함수 본문은 그대로 옮기고 Electron 호출만 위 Interfaces 대로 바꾼다
- [ ] **Step 4:** `npm test` 전체 통과 + `ROOMS_SMOKE=1 npm start -w app`(Electron) ok + `npm start -w app` 으로 Electron 화면이 그대로 동작하는지 캡처(`ROOMS_SCREENSHOT`)로 확인
- [ ] **Step 5:** 사용자 확인 뒤 커밋 `refactor: 앱 로직을 Electron 과 분리(service·core)`

### Task 3: 캡처를 코어 시나리오로 (Node)

**Files:**
- Modify: `app/main/capture.js` — 데이터 준비는 그대로, 화면 조작(`executeJavaScript`·`capturePage`)을 "찍을 장면 알림 + 응답 대기"로 바꾼다
- Modify: `app/main/service.js`(`start({ capture: true })` 일 때 시나리오 실행), `app/main/index.js`(Electron 쪽 장면 처리)
- Test: `app/test/capture.test.js`

**Interfaces:**
- Produces: 캡처 모드 코어 알림 `capture:shot` payload `{ name: string, view: 'login'|'rooms'|'room', opts: object, dark: boolean }`. 앱이 그 장면을 그리고 PNG 를 저장한 뒤 처리기 `captureAck({ name })` 를 부르면 다음 장면으로. 끝나면 알림 `capture:done` `{ ok: boolean }`.
  - 장면 이름·순서는 지금 21장 그대로(`01-login` … `10-update`). `opts` 는 지금 `window.__debug.go(view, opts)` 에 넘기던 값(탭·미리보기 경로·시트 등).
  - Electron 쪽은 `capture:shot` 을 받아 지금처럼 `__debug.go` + `capturePage` 를 하고 `captureAck` 를 부른다(전환 기간에도 docs 캡처 유지).

- [ ] **Step 1: 테스트** — 코어를 `ROOMS_SCREENSHOT=<tmp>` 로 띄우고 `capture:shot` 이 올 때마다 `captureAck` 를 보내는 하네스:
  - `capture: 21개 장면이 정해진 순서로 오고 capture:done ok:true`
- [ ] **Step 2:** 실패 확인
- [ ] **Step 3:** 구현
- [ ] **Step 4:** 테스트 통과 + Electron 캡처 21장이 전과 같게 나오는지 직접 확인
- [ ] **Step 5:** 사용자 확인 뒤 커밋 `refactor: 화면 캡처를 코어 시나리오로`

### Task 4: Swift 패키지·코어 클라이언트·Node 찾기

**Files:**
- Create: `mac/test.sh`(swiftc 로 RoomsKit 을 `-enable-testing` 라이브러리로, 테스트를 Swift Testing 러너로 빌드·실행), 루트 `package.json` 의 `test:mac`. `Package.swift` 는 두지 않는다(설계 S4)
- Create: `mac/Sources/RoomsKit/JSON.swift`, `CoreClient.swift`, `LineBuffer.swift`, `RestartPolicy.swift`, `NodeLocator.swift`
- Test: `mac/Tests/RoomsKitTests/*.swift`, 가짜 코어 `mac/Tests/RoomsKitTests/Fixtures/fake-core.mjs`

**Interfaces:**
- Produces:
  - `public enum JSON: Codable, Equatable, Sendable { case null, bool(Bool), number(Double), string(String), array([JSON]), object([String: JSON]) }` + `subscript(key: String) -> JSON?`, `var string: String?`, `var int: Int?`, `var bool: Bool?`, `var array: [JSON]?`
  - `public struct LineBuffer { public mutating func append(_ data: Data) -> [Data] }` — `\n` 로 끊고 나머지는 보관(바이트 기준이라 한글이 조각 경계에서 잘려도 줄이 완성된 뒤 디코드)
  - `public struct CoreLaunch { executable: URL; arguments: [String]; environment: [String: String]; logURL: URL }`
  - `public final class CoreClient: @unchecked Sendable` — `init(_ launch: CoreLaunch)`, `func start() throws`, `func call(_ name: String, _ args: JSON = .object([:]), timeout: Duration? = .seconds(120)) async throws -> JSON`, `var events: AsyncStream<CoreEvent>`, `var onExit: (@Sendable (Int32) -> Void)?`, `func stop()`
    - `public struct CoreEvent: Sendable { name: String; payload: JSON }`
    - `public enum CoreError: Error, Equatable { case remote(String), timeout, notRunning }`
    - stderr 는 `logURL` 에 이어 쓰고 1MB 넘으면 뒤 512KB 만 남김
    - 시간 제한 없음(`timeout: nil`)으로 부를 기능: `cloneRepo`, `applyUpdate`, `claudeLogin`
  - `public struct RestartPolicy { init(max: Int = 3, window: TimeInterval = 60); mutating func shouldRestart(at: Date) -> Bool }`
  - `public enum NodeLocator { static func find(shell: String?, run: (String, [String]) -> String?, exists: (String) -> Bool) -> String? }` — `run(shell, ["-ilc","command -v node"])` → `/opt/homebrew/bin/node` → `/usr/local/bin/node` 순. 로그인 셸 PATH 도 같은 방식(`printf %s "$PATH"`)으로 `static func loginPath(...) -> String?`

- [ ] **Step 1: 테스트**
  - `LineBufferTests.testSplitsAndKeepsPartial` — `"a\nb"`+`"c\n"` → `["a"]`, 그다음 `["bc"]`
  - `LineBufferTests.testKoreanSplitMidCharacter` — `"한글\n"` 의 UTF-8 을 2바이트째에서 끊어 넣어도 `"한글"` 한 줄(Review Focus 2)
  - `CoreClientTests.testCallReturnsData` / `testRemoteError` / `testEventStream` / `testTimeout` — `fake-core.mjs`(echo·fail·emit·sleep 처리기를 Task 1 형식으로)를 `node` 로 띄움
  - `CoreClientTests.testExitCallback` — 가짜 코어가 `exit` 처리기로 종료 → `onExit` 호출, 대기 중 call 은 `.notRunning`
  - `RestartPolicyTests` — 60초 안 3번 true, 4번째 false, 61초 뒤 다시 true(Review Focus 4)
  - `NodeLocatorTests` — 셸 결과 우선 / 셸 실패 시 `/opt/homebrew/bin/node` / 둘 다 없으면 `/usr/local/bin/node` / 전부 없으면 nil(Review Focus 3)
- [ ] **Step 2:** `npm run test:mac` → 실패 확인
- [ ] **Step 3:** 구현(`Process` + `Pipe`, 응답 대기는 `[Int: CheckedContinuation]` 를 직렬 큐로 보호)
- [ ] **Step 4:** `npm run test:mac` 통과
- [ ] **Step 5:** 사용자 확인 뒤 커밋 `feat: Swift 패키지와 코어 클라이언트`

### Task 4b: UI/UX 점검표

**Files:**
- Create: `docs/2026-11-27-ui-review.md`

**내용:** 지금 캡처 21장(`docs/screens-2026-11-26/`)과 화면 코드를 화면별로 훑어 문제를 적고, 고칠 방안을 **제안**으로 적는다(사용자가 정하기 전까지 확정 아님).
- 점검 기준: 설명글 길이(한 줄 안팎으로), 버튼 크기·모양 일관성(크기 단계 정의 — 예: 큰 버튼/보통/작은 텍스트 버튼), 글자 크기·대비·줄 간격(가독성), 정보 위계(제목·본문·보조 글), 직관성(무엇을 누르면 무엇이 되는지, 상태가 한눈에 보이는지), 빈 상태·오류 문구, 다크 모드 대비.
- 사용자 지적(확정, 11-27): 버튼이 전체적으로 너무 크다 → 버튼 크기 단계를 지금보다 줄인다(지금 큰 버튼 높이 56·패널 버튼 48 등). 맥 앱 기준 크기로 맞추는 안을 점검표에 숫자로 제안한다
- 사용자 지적(확정, 11-27): 글이 어색하게 줄바꿈되는 게 보기 싫다(예: 공유 탭 안내 한 줄이 세 줄로, 멤버 요약·레포 카드의 긴 경로가 여러 줄로) → 화면별로 줄넘김이 생기는 곳을 찾아 문구 줄이기·한 줄 말줄임(…)+전체는 툴팁·배치 변경 중 하나를 제안한다
- 결과물: ① 화면별 문제와 제안 표 ② 공통 기준(글자 크기 단계, 버튼 크기 단계, 간격 단위, 색 역할) ③ 바꿀 문구 목록(지금 → 제안).

- [ ] **Step 1:** 점검표 작성(위임 가능 — 단, 공통 기준은 메인이 정리)
- [ ] **Step 2:** 사용자 검토 — 채택·수정·제외를 표에 적는다
- [ ] **Step 3:** 사용자 확인 뒤 커밋 `docs: UI/UX 점검표`

### Task 5: 앱 뼈대·빌드 스크립트·로그인·방 목록·캡처 처리

**Files:**
- Create: `mac/build.sh`, 루트 `package.json` 스크립트 `"mac": "bash mac/build.sh"`
- Create: `mac/Sources/ClaudeRooms/App.swift`(@main, 창 1개, 최소 크기 960×640), `AppModel.swift`, `Theme.swift`, `Fonts.swift`, `MacActions.swift`, `Capture.swift`, `Views/LoginView.swift`, `Views/RoomListView.swift`, `Views/Common/*.swift`(카드·버튼·토스트·띠)
- Create: `mac/Sources/RoomsKit/Format.swift` + `mac/Tests/RoomsKitTests/FormatTests.swift`

**Interfaces:**
- Consumes: Task 2 코어 기능, Task 3 `capture:shot`/`captureAck`, Task 4 `CoreClient`·`NodeLocator`·`RestartPolicy`
- Produces:
  - `@MainActor @Observable final class AppModel` — `screen: Screen`(`.needNode`, `.login(serverUrl)`, `.rooms`, `.room(id, tab, preview)`), `user`, `claude`, `usage`, `update`, `connected`, `coreDown: Bool`, `toast(_ text: String)`, `func call(_ name: String, _ args: JSON = …) async throws -> JSON`(오류 코드를 `Format.errorText` 로 토스트). 코어 알림을 받아 상태 갱신, `relaunch` 알림 → `MacActions.relaunch()`
  - `MacActions` — `pickFolder() -> String?`(NSOpenPanel 폴더), `open(_ path: String)`, `reveal(_ path: String)`, `openURL(_ url: URL)`(http/https 만), `relaunch()`(자기 번들을 새 인스턴스로 띄우고 종료)
  - `Format`(RoomsKit) — `format.js` 의 `formatTime`, `formatDate`, `usageLabel`, `usageWarn`, `usageChecked`, `modelLabel`, `effortLabel`, `memberSummary`, `personIndex`, `initial`, `errorText`, `failText`, `STATUS_TEXT` 를 같은 결과로. 테스트는 `app/test/format.test.js` 의 기대값을 그대로 옮긴다
  - `build.sh` — `swiftc -O -swift-version 6 -parse-as-library` 로 `Sources/RoomsKit/*.swift`·`Sources/ClaudeRooms/**/*.swift` 를 한 실행 파일로 → `Claude Rooms.app/Contents/{MacOS/ClaudeRooms, Info.plist, Resources/Fonts/*.otf}` 조립 → `~/Applications` 로 교체. Info.plist: `CFBundleName`=Claude Rooms, `CFBundleIdentifier`=dev.claude-rooms.app, `CFBundleExecutable`=ClaudeRooms, `LSMinimumSystemVersion`=14.0, `RoomsSource`=레포 절대 경로, `RoomsCommit`=짧은 HEAD. 아이콘은 이번 계획에서 제외(기본 아이콘)
  - 캡처: 환경 변수 `ROOMS_SCREENSHOT` 이면 코어에 그대로 넘기고, `capture:shot` 마다 `screen`·다크 모드를 맞추고 0.5초 뒤 창 내용을 PNG(`<폴더>/<name>.png`, 1100×728)로 저장 → `captureAck`. `capture:done` 이면 종료(실패면 코드 1)
    - 앞 장면과 `view`·`opts`·`dark` 가 같으면 화면을 다시 열지 않고 `ui`(codeDiffOpen·scrollTo·composer)만 적용한다(Electron `createShoot` 와 같은 규칙, `capture.js` 맨 위 주석)
    - 승인 대기 알림(`run.approval pending`)은 방 화면이 열리는 중(약 300ms 뒤)에 올 수 있다 → 방 화면이 만들어지기 전에 온 `rooms:event` 도 놓치지 않게 AppModel 이 방별로 받아 두었다가 RoomModel 에 넘긴다(Task 6)

- [ ] **Step 1: 테스트** — `FormatTests`(format.test.js 기대값 그대로)
- [ ] **Step 2:** `npm run test:mac` 실패 확인
- [ ] **Step 3:** 구현. 코어 시작: `RoomsSource` 의 `app/main/core.js`, 환경 = 로그인 셸 PATH + `ROOMS_HOME`(있으면). 코어 종료 시 `RestartPolicy` 로 다시 띄우고, 멈추면 띠 "연결이 끊겼어요 · 로그 ~/.claude-rooms/core.log"
- [ ] **Step 4:** `npm run test:mac` 통과, `npm run mac` 성공, `open ~/Applications/Claude\ Rooms.app` 으로 로그인→방 목록이 실제 서버에 붙는지 확인, `ROOMS_SCREENSHOT=<tmp> ~/Applications/Claude\ Rooms.app/Contents/MacOS/ClaudeRooms` 로 `01-login`·`02-rooms`(·dark) 가 Electron 캡처와 같은 구성인지 눈으로 비교(나머지 장면은 아직 빈 화면이어도 됨)
- [ ] **Step 5:** 사용자 확인 뒤 커밋 `feat: Swift 앱 뼈대·로그인·방 목록`

### Task 6: 방 화면 — 머리·채팅

**Files:**
- Create: `mac/Sources/ClaudeRooms/Views/Room/RoomView.swift`, `RoomModel.swift`, `ChatView.swift`, `MessageViews.swift`(사람 말풍선·Claude 블록·도구 줄·상태 칩·diff 카드), `Markdown.swift`

**Interfaces:**
- Consumes: 코어 `openRoom`, `retry`, `cancelRequest`, 알림 `rooms:event`(`message.new`/`message.update`/`room.state`/`member.status`/`run.approval`/`room.delete`/`local.repos`/`shared.changed`/`local.sharedConflict`)
- Produces: `@MainActor @Observable final class RoomModel(roomId: Int, app: AppModel)` — `state`, `messages`, `memberStatus`, `approvals`, `myModel`, `tab`, `func apply(_ event: CoreEvent)`. 메시지→화면 변환 규칙은 `app/renderer/views/room.js` 의 `claudeBlock`·`toolSummary`·사람 배치(모두 오른쪽, 사람마다 `personIndex` 색, 내 메시지 파랑)를 그대로
- Markdown: `AttributedString(markdown:, options: .init(interpretedSyntax: .full))` 의 `presentationIntent` 로 블록(제목·문단·목록·인용·코드 블록·표·구분선)을 나눠 SwiftUI 로 그린다(설계 5장). `RoomsKit/MarkdownBlocks.swift` 에 `func markdownBlocks(_ text: String) -> [MarkdownBlock]` 를 두고 테스트(`MarkdownBlocksTests` — 제목/목록/코드 블록/표/원문 HTML/링크 스킴)한다. 원문 HTML 블록은 코드처럼 글자로, 링크는 http(s) 만 `MacActions.openURL`, 이미지는 대체 글자

- [ ] **Step 1:** (화면이라 단위 테스트 대신) 캡처 장면 `03-room-chat`·`03b-room-code`·`03c-room-people`(라이트·다크)를 기준으로 삼는다
- [ ] **Step 2:** 구현(위임 가능: 범위 = 위 파일, 기준 = Electron 캡처와 같은 구성)
- [ ] **Step 3:** 캡처로 6장 확인 + 실제 서버에서 방 열기·메시지 수신·Claude 요청 상태 변화(대기→실행 중→완료)·[중단]·[다시 보내기] 직접 확인
- [ ] **Step 4:** 사용자 확인 뒤 커밋 `feat: Swift 방 화면 채팅`

### Task 7: 입력창 — 대상 전환·모델 선택·자동완성

**Files:**
- Create: `mac/Sources/ClaudeRooms/Views/Room/Composer.swift`, `AutocompleteView.swift`
- Create: `mac/Sources/RoomsKit/Complete.swift` + `mac/Tests/RoomsKitTests/CompleteTests.swift`

**Interfaces:**
- Consumes: 코어 `sendMessage`, `setRoomModel`, `listSkills`, `listShared`, `listRepoFiles`, `Format.modelLabel`
- Produces: `Complete`(RoomsKit) — `app/renderer/complete.js` 의 함수들을 같은 결과로(현재 단어 찾기·후보 거르기·치환). 모델 목록 `MODELS = ["claude-opus-5-5","claude-fable-5-2","claude-sonnet-5-5","claude-haiku-5-5"]`, 노력 `["low","medium","high","xhigh","max"]`
- 규칙(지금과 같음): 기본 [Claude], `/` 로 시작하면 대상과 무관하게 Claude, [사람]이면 사람끼리만. Enter 보내기, Shift+Enter 줄바꿈, 자동완성 열려 있으면 ↑↓·Enter·Tab·Esc

- [ ] **Step 1: 테스트** — `CompleteTests`(`app/test/` 에 complete 테스트가 있으면 그 기대값, 없으면 `complete.js` 의 각 분기: `@` 멤버/파일, `/` 명령, 단어 중간, 후보 없음)
- [ ] **Step 2:** 실패 확인 → **Step 3:** 구현 → **Step 4:** `npm run test:mac` + 캡처 `09-autocomplete`(·dark)·`09b-autocomplete-mention` + 실제로 `/compact`·스킬·`@파일` 보내기 확인
- [ ] **Step 5:** 사용자 확인 뒤 커밋 `feat: Swift 입력창·자동완성`

### Task 8: 오른쪽 패널 — 레포·공유 파일·멤버

**Files:**
- Create: `mac/Sources/ClaudeRooms/Views/Room/ReposPanel.swift`, `SharedPanel.swift`, `MembersPanel.swift`

**Interfaces:**
- Consumes: 코어 `checkRepos`, `linkRepo`, `cloneRepo`, `inspectRepo`, `addRepo`, `updateRepo`, `removeRepo`, `openFolder`, `listReadDirs`/`addReadDir`/`removeReadDir`, `listShared`, `openShared`, `renameRoom`, `regenerateInvite`, `deleteRoom`, `leaveRoom`, `setRoomSettings`; `MacActions.pickFolder/open/reveal`
- 문구·버튼·순서는 `room.js` 의 `reposPanel`·`repoCard`·`sharedPanel`·`membersPanel` 그대로

- [ ] **Step 1:** 기준 캡처 `04-room-repos`·`07-members`(·dark)
- [ ] **Step 2:** 구현(위임 가능) → **Step 3:** 캡처 확인 + 실제로 폴더 고르기·clone·폴더 열기·공유 [Finder 에서 열기]·초대 코드 다시 만들기 확인
- [ ] **Step 4:** 사용자 확인 뒤 커밋 `feat: Swift 방 오른쪽 패널`

### Task 9: 시트·승인 창·띠

**Files:**
- Create: `mac/Sources/ClaudeRooms/Views/Sheets/InputSheet.swift`, `ConfirmSheet.swift`, `PreviewSheet.swift`, `DiffSheet.swift`, `ApprovalSheet.swift`, `UpdateSheet.swift`; `Views/Common/Banners.swift`

**Interfaces:**
- Consumes: 코어 `readShared`, `answerApproval({ id, decision })`, `applyUpdate`, `checkUpdate`, 알림 `approval:ask`/`approval:close`/`update`/`conn:status`
- PreviewSheet: md → Task 6 의 마크다운 뷰, html/htm → WKWebView(`javaScriptEnabled=false`, 외부 리소스 막는 콘텐츠 규칙), 그 밖 → 고정폭 텍스트(앞 200KB, 넘으면 "… 앞 200KB 까지만 보여요"). 버튼 [Finder 에서 보기]·[기본 앱으로 열기]/html 이면 [브라우저로 열기]·[닫기]
- 승인 창은 닫기 금지(지금처럼 응답해야 닫힘), 여러 개면 차례로

- [ ] **Step 1:** 기준 캡처 `05-shared-md`·`06-shared-html`·`08-approval`(·dark)·`10-update`
- [ ] **Step 2:** 구현(위임 가능) → **Step 3:** 캡처 확인 + 실제로 승인 허용/거부, 미리보기 버튼, 업데이트 띠 확인
- [ ] **Step 4:** 사용자 확인 뒤 커밋 `feat: Swift 시트·승인 창·띠`

### Task 10: 서버 호스트 스위치

**Files:**
- Create: `mac/Sources/ClaudeRooms/ServerHost.swift`, `Views/SettingsView.swift`(⌘, 설정 창)

**Interfaces:**
- Consumes: 코어 `getConfig().hostServer`, `setHostServer({ on })`
- Produces: `ServerHost` — `start(node: String, source: URL)`: 먼저 `GET http://127.0.0.1:4310/version`(1초) 응답이 오면 시작하지 않고 "이미 4310 에서 서버가 돌고 있어요" 토스트. 아니면 `node server/src/supervisor.js` 를 자식으로(stdout·stderr → `~/.claude-rooms/server.log`). `stop()`: SIGINT 후 5초 뒤 SIGKILL. 앱 시작 때 `hostServer` 면 자동 시작, 앱 종료 때 stop
- 설정 문구: "[이 맥에서 서버 실행] — 앱을 완전히 종료(⌘Q)하면 서버도 꺼져요. 로그: ~/.claude-rooms/server.log"

- [ ] **Step 1:** 구현 → **Step 2:** 직접 확인 — 스위치 켬 → 서버 뜸(`curl /version`), 다른 맥(또는 두 번째 앱)이 접속, ⌘Q → 서버 꺼짐, 터미널 서버가 이미 있을 때 켜면 토스트
- [ ] **Step 3:** 사용자 확인 뒤 커밋 `feat: 앱에서 서버 실행`

### Task 11: 업데이트에 Swift 빌드 추가 (Node)

**Files:**
- Modify: `shared/sourceUpdate.js` — `pullFf` 결과에 `changed: string[]`(`git diff --name-only before after`)
- Modify: `app/main/updater.js` — `createUpdater({ …, build })`, `apply()` 에서 `changed` 에 `mac/` 로 시작하는 경로가 있으면 `await build(root)`; 실패면 `throw new Error('UPDATE_BUILD_FAILED')` 하고 relaunch 하지 않음. 기본 `build` = `npm run mac`(10분 제한)
- Modify: `app/renderer/format.js`·`mac/Sources/RoomsKit/Format.swift` — `UPDATE_BUILD_FAILED` 문구 "앱을 빌드하지 못했어요. 지금 버전을 그대로 써요(로그 ~/.claude-rooms/core.log)"
- Test: `app/test/updater.test.js`, `server/test/` 쪽 sourceUpdate 테스트가 있으면 거기에 `changed`

- [ ] **Step 1: 테스트**
  - `updater: mac/ 가 바뀌면 build 를 부르고 그 뒤 relaunch`
  - `updater: mac/ 가 안 바뀌면 build 를 부르지 않는다`
  - `updater: build 가 실패하면 UPDATE_BUILD_FAILED, relaunch 안 함`(Review Focus 5)
- [ ] **Step 2:** 실패 확인 → **Step 3:** 구현 → **Step 4:** `npm test` 통과
- [ ] **Step 5:** 사용자 확인 뒤 커밋 `feat: 업데이트 때 맥 앱 다시 빌드`

### Task 12: 전체 캡처·맥 두 대 확인·Electron 삭제

**Files:**
- Delete: `app/renderer/`, `app/main/preload.cjs`, `app/main/index.js`(Electron 껍데기), `app/scripts/vendor.mjs`, `app/package.json` 의 `electron`·`start`·`prestart`, 루트 `host` 스크립트를 `npm run mac` 안내로 교체
- Modify: `README.md`(설치 = `npm install && npm run mac`, 실행 = Dock/Spotlight, 서버 = 앱 설정 스위치 또는 `npm start -w server`), `docs/2026-11-26-claude-rooms-design.md`(결정 39: 맥 앱 Swift 전환, 설계 문서 링크), `docs/screens-2026-11-26/*.png`(Swift 캡처로 교체)
- Modify: `app/main/capture.js`·Task 3 Electron 쪽 처리 제거

- [ ] **Step 1:** Swift 캡처 21장 생성·확인 → docs 교체
- [ ] **Step 2:** 맥 두 대 확인표(설계 7장)를 하나씩 — 로그인·방·대화 이어 가기·승인 창·중단·worktree diff·공유 파일 직접 수정·사용량·업데이트(Swift 빌드 포함)·서버 호스트 스위치. 결과를 표로 보고
- [ ] **Step 3:** 사용자 확인 뒤 Electron 삭제, `npm test`·`npm run test:mac` 통과
- [ ] **Step 4:** 사용자 확인 뒤 커밋 `refactor: Electron 앱 삭제, Swift 앱으로 전환`
