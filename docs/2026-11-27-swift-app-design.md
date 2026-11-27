# Claude Rooms 맥 앱(Swift) 설계

작성 2026-11-27. 기존 설계(`2026-11-26-claude-rooms-design.md`)의 기능·결정은 그대로 두고, **데스크톱 앱의 화면과 껍데기만** Electron 에서 SwiftUI 로 바꾼다.

## 1. 정한 것

| # | 결정 |
|---|---|
| S1 | 목적: 진짜 맥 앱처럼(더블클릭·Dock·가볍고 빠른 네이티브 화면). 멤버 맥에 Node 가 있어도 된다 |
| S2 | 방식: **SwiftUI 화면 + Node 코어**. 지금 `app/main` 로직은 Electron 의존만 떼어 앱이 띄우는 Node 자식 프로세스로 재사용한다. 서버(`server/`)는 바꾸지 않는다 |
| S3 | 업데이트: 각 맥에 소스(`~/claude-rooms`)를 두고 [업데이트] = `git pull` → (lock 바뀌면) `npm install` → (`mac/` 바뀌면) Swift 빌드·`.app` 교체 → 다시 켜기 |
| S4 | (2026-11-27 수정) 빌드는 Xcode·SwiftPM 없이 Command Line Tools 의 `swiftc` 로 직접(`mac/build.sh`·`mac/test.sh`). 외부 Swift 라이브러리는 쓰지 않는다. 최소 macOS 14. 까닭: 이 맥의 CLT 에서 SwiftPM 이 빈 패키지조차 못 빌드하고(PackageDescription dylib·swiftmodule 버전 불일치), 관리자 권한이 없어 재설치할 수 없다. 각자 빌드(S3)에서도 의존이 적은 쪽이 덜 깨진다 |
| S5 | (2026-11-27 수정) 토스 스타일·Pretendard·다크 모드(시스템 설정)는 유지하되, 옮기면서 **UI/UX 를 전체 점검해 개선**한다 — 너무 긴 설명글, 제각각인 버튼 크기, 떨어지는 가독성, 직관적이지 않은 흐름 등. 점검표와 고칠 방안을 먼저 만들어 확인받고(계획 Task 4b), 그 기준으로 Swift 화면을 만든다 |
| S6 | Electron 버전은 Swift 앱이 맥 두 대 확인을 통과할 때까지 두고, 통과하면 지운다 |

## 2. 구조

```
Claude Rooms.app (SwiftUI)
 ├─ 화면: 로그인 · 방 목록 · 방(채팅·레포·공유 파일·멤버) · 시트 · 띠·토스트
 ├─ 맥 기능: 폴더 고르기(NSOpenPanel) · Finder/브라우저로 열기(NSWorkspace) · 자기 다시 실행
 └─ Node 코어: node <소스>/app/main/core.js (stdin/stdout JSON)
     └─ 지금 로직: 서버 연결 · Claude 실행 · worktree · 공유 폴더 동기화 · 승인 도구(MCP)
        · 레포 찾기 · 사용량 · 업데이트
server/ — 변경 없음
```

폴더:
- `app/main/` — Node 코어. `index.js` 의 IPC 처리기(handlers)를 Electron 과 무관한 모듈로 떼고, 진입점을 둘 둔다: `core.js`(stdio, Swift 앱용)와 기존 Electron 진입점(전환 기간에만).
- `mac/` — Swift 소스(`Sources/RoomsKit/…` UI 없는 로직, `Sources/ClaudeRooms/…` 앱), `Resources/`, `build.sh`(앱), `test.sh`(RoomsKit 테스트, Swift Testing).
- `app/renderer/`, Electron 진입점·`preload.cjs`, `electron` 의존 — 전환 끝에 삭제.

## 3. Swift ↔ Node 코어 통신

- 한 줄에 JSON 하나(UTF-8, `\n` 구분).
  - 요청 `{"id":1,"call":"openRoom","args":{...}}`
  - 응답 `{"id":1,"ok":true,"data":...}` / `{"id":1,"ok":false,"error":"CODE"}`
  - 알림 `{"event":"rooms:event","payload":...}`
- 기능은 지금 `preload.cjs` 의 40개 이름과 인자·결과를 그대로 쓴다. 알림도 그대로 6개: `rooms:event`, `approval:ask`, `approval:close`, `conn:status`, `usage`, `update`.
- 맥 기능 나눔:
  - `pickFolder` — Swift 가 NSOpenPanel 로 고른다(코어에 없음).
  - `openFolder`, `openShared` — 코어는 지금 경로 검사를 그대로 하고 **열 경로와 방식**(`open`/`reveal`)을 돌려준다. Swift 가 NSWorkspace 로 연다.
  - 링크 열기 — Swift 가 http(s) 만 기본 브라우저로.
  - 다시 켜기 — 코어가 `{"event":"relaunch"}` 를 보내면 Swift 가 새 `.app` 을 띄우고 종료한다.
- 수명: 앱이 코어를 띄우고, stdin 이 닫히면 코어는 스스로 끝난다. 코어가 비정상 종료하면 앱이 "연결이 끊겼어요" 띠를 띄우고 다시 띄운다(1분에 3번까지, 넘으면 멈추고 로그 위치 안내).
- 로그: 코어 stderr → `~/.claude-rooms/core.log`(앱이 이어 씀, 1MB 넘으면 앞부분 버림).
- stdout 은 통신 전용이다. 코어 안의 `console.log` 는 stderr 로 돌린다.

## 4. Node 찾기

Dock 에서 켠 앱은 PATH 에 Homebrew 경로가 없다. 앱 시작 때 `$SHELL -ilc 'command -v node'` 로 찾고(5초 제한), 실패하면 `/opt/homebrew/bin/node`, `/usr/local/bin/node` 를 차례로 본다. 못 찾으면 "Node 가 필요해요(설치 방법)" 화면을 보여 준다. 코어에는 로그인 셸 PATH 를 넘긴다(claude·git 도 같은 이유).

## 5. 화면

지금 화면 구성을 기준으로 하되, Task 4b 점검표에서 정한 개선을 반영한다.

| 화면 | 구성 |
|---|---|
| 로그인 | 서버 주소(스킴 없으면 http:// 보정은 코어가), 가입/로그인 |
| 방 목록 | Claude 카드(계정·사용량 막대·마지막 확인), 방 카드, [방 만들기]·[초대 코드로 참가], 위 [업데이트 확인]·[로그아웃] |
| 방 | 위: ← 목록·방 이름·사용량 막대·멤버 수 / 가운데: 채팅 / 아래: 입력 / 오른쪽: 패널 |
| 채팅 | 사람 메시지는 모두 오른쪽(사람마다 색·이니셜 아바타·이름·[Claude 에게] 표시), Claude 는 왼쪽(`Claude · Opus 5.5`), 도구 호출 한 줄(펼치기), diff 카드, 상태 칩(대기·실행 중·승인 대기·완료·실패·중단됨), [중단]·[다시 보내기] |
| 입력 | [Claude/사람] 전환, 모델·노력 선택(방 기본 표시·[방 기본으로]), 여러 줄 입력, `@`(멤버·공유 파일·레포 파일)·`/`(명령·스킬) 자동완성 |
| 패널 | 레포(카드·폴더 고르기·clone·폴더 열기·수정·삭제·함께 읽을 폴더) / 공유 파일(안내 한 줄·[Finder 에서 열기]·목록) / 멤버(연결 요약·방 기본 모델·초대 코드·이름 바꾸기·나가기·삭제) |
| 시트 | 입력·확인, 미리보기(md·HTML·텍스트, [Finder 에서 보기]·[기본 앱으로 열기]/[브라우저로 열기]), diff, 승인 창, 업데이트 내역 |
| 띠·알림 | 새 버전 띠, 서버 버전 다름 띠, 연결 끊김 띠, 토스트 |
| 설정 | [이 맥에서 서버 실행] 스위치(6장) |

- 마크다운: 외부 라이브러리 없이 Apple 기본 `AttributedString(markdown:, options: .init(interpretedSyntax: .full))` 의 블록 정보(`presentationIntent` — 제목·목록·인용·코드 블록·표)로 SwiftUI 뷰를 직접 그린다. 원문 HTML 은 글자로, 링크는 http(s) 만, 이미지는 대체 글자(지금 규칙과 같음).
- HTML 미리보기: WKWebView, 자바스크립트 끔, 외부 요청 막음. 스크립트가 필요한 아티팩트는 [브라우저로 열기].
- 글꼴: `node_modules/pretendard/dist/public/static/*.otf`(Regular·Medium·SemiBold·Bold)를 빌드 때 앱에 넣고 CTFontManager 로 등록.
- 색: 지금 `tokens.css` 의 값을 Swift 색 상수로(라이트·다크 두 벌).
- 화면 캡처: `ROOMS_SCREENSHOT=<폴더>` 로 켜면 코어가 지금 `capture.js` 의 가짜 데이터로 돌고, 앱이 화면마다 창을 PNG 로 저장한 뒤 끝난다(`docs/screens-*` 갱신·확인용).

## 6. 빌드·업데이트·서버

- `npm run mac` → `mac/build.sh`: `swiftc -O` 로 RoomsKit·앱 소스를 한 실행 파일로 빌드 → `Claude Rooms.app` 조립(Info.plist 에 이름·번들 ID·소스 폴더 경로·커밋, 아이콘, 글꼴) → `~/Applications/Claude Rooms.app` 으로 교체.
- 업데이트(코어 `updater`): 지금 순서에 한 단계 추가 — `git pull --ff-only` 로 `mac/` 이 바뀌었으면 `npm run mac` 을 돌리고 성공해야 다시 켠다. 빌드 실패면 다시 켜지 않고 "빌드 실패(로그)"를 알린다(지금 버전은 그대로 동작). 앱은 자기를 빌드한 커밋(Info.plist `RoomsCommit`)을 코어에 넘긴다(`ROOMS_APP_COMMIT`). 서버를 켜 둔 맥에서는 관리 프로그램이 같은 소스를 먼저 pull 하므로, 받을 커밋이 0개여도 빌드 커밋 뒤로 `mac/` 이 바뀌었으면 "앱을 새로 빌드해야 해요" 띠와 [업데이트]로 알린다. 소스에 로컬 수정이 있거나 Claude 실행 중이면 지금처럼 멈추거나 기다린다.
- 서버 호스트: 설정의 [이 맥에서 서버 실행]을 켜면 앱이 `node server/src/supervisor.js` 를 자식으로 띄우고 로그는 `~/.claude-rooms/server.log`. 켜기 전에 4310 포트를 이미 누가 쓰면 켜지 않고 알린다. 앱을 ⌘Q 로 끄면 서버도 꺼진다(스위치 옆에 적음). 설정은 `~/.claude-rooms/config.json` 의 `hostServer`.
- `npm run host`·`start:raw` 는 남긴다(터미널로 서버만 켜는 경우).

## 7. 검증

- 코어: 지금 앱 테스트를 그대로 돌린다(Electron 에 묶인 테스트만 코어 기준으로 고침). 통신 계층 테스트 추가 — 요청/응답 짝, 오류 코드, 알림, 잘못된 줄 무시, stdin 닫히면 종료.
- Swift: 통신 클라이언트(줄 나누기·응답 짝·시간 초과)와 표시 함수(시간·사용량 문구·모델 이름)를 `npm run test:mac`(`mac/test.sh`, swiftc + Swift Testing) 로.
- 화면: 캡처 모드로 화면마다 PNG 를 만들어 직접 확인.
- 맥 두 대: 로그인·방·대화 이어 가기·승인 창·중단·worktree diff·공유 파일 직접 수정·사용량·업데이트(Swift 빌드 포함)·서버 호스트 스위치.

## 8. 전환 순서

1. 코어 분리(`core.js`, 통신 테스트). Electron 버전은 같은 로직으로 계속 동작.
2. Swift 뼈대: 패키지·`build.sh`·Node 찾기·코어 연결·로그인·방 목록.
3. 방 화면: 채팅·입력·자동완성·모델 선택.
4. 패널·시트: 레포·공유 파일·멤버·미리보기·diff·승인 창.
5. 업데이트(Swift 빌드)·서버 호스트·화면 캡처.
6. 맥 두 대 확인 → Electron·`app/renderer`·`preload.cjs` 삭제, README·설계 문서 갱신.

단계마다 사용자 확인 뒤 커밋한다.

## 9. 범위 밖

- 코드 서명·공증, GitHub Releases 배포(결정 S3 로 불필요).
- Windows·Linux.
- 서버·프로토콜 변경.
