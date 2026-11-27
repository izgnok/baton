# Baton — 앱 이름·디자인 다시 정하기

작성 2026-11-27. 앱 이름을 "Claude Rooms"에서 **Baton** 으로 바꾸고, 화면 스타일을 "차분한 노트"로 바꾼다. UI 점검표(`2026-11-27-ui-review.md`)의 크기·배치 기준은 그대로 두고 **모양(색·글꼴·모서리)과 이름**만 바꾼다.

## 1. 사용자가 정한 것

| # | 결정 |
|---|---|
| B1 | 바꾸는 이유: 디자인이 밋밋함 / 이름에 "Claude"가 들어가 공식 앱처럼 보임 / 이름이 "같이 코딩하는 공간"이라는 기능과 안 맞음 |
| B2 | 이름은 **Baton**(대화를 바통처럼 넘겨 이어 쓴다). 같은 분야에 같은 이름의 앱이 여럿 있지만(앱스토어 "Baton - Claude Code & Codex", Product Hunt "baton 2", 오픈소스 batonai 등) 앱스토어 배포 없이 팀 안에서만 쓰므로 그대로 쓴다 |
| B3 | 디자인 방향은 **C. 차분한 노트**(종이 같은 바탕, 진녹색 포인트, 각진 모서리, 세리프 제목) |
| B4 | 이름은 **전부** 바꾼다: 앱 이름·번들, 화면 문구, 문서, GitHub 레포, 데이터 폴더(`~/.claude-rooms` → `~/.baton`, 자동 이전), 환경 변수(`ROOMS_*` → `BATON_*`), 내부 패키지 이름. 앱 안의 기능 이름 "방(room)"은 그대로 |

## 2. 디자인 기준

### 2.1 색(밝게 / 어둡게)

| 이름 | 밝게 | 어둡게 | 쓰는 곳 |
|---|---|---|---|
| 바탕 | `#F6F3EC` | `#1C1B19` | 창 바탕, 채팅 영역 |
| 패널 | `#EFEADF` | `#232220` | 오른쪽 패널, 보조 버튼 바탕 |
| 카드 | `#FFFDF8` | `#2A2926` | 카드·입력칸·남의 말 상자·시트 |
| 선 | `#DDD5C5` | `#3A3833` | 테두리·구분선 |
| 글자 | `#2A2622` | `#E9E4D8` | 본문 |
| 보조 글자 | `#6F665A` | `#A39B8C` | 시간·상태·설명 (밝게는 처음 `#7C7365` 에서 대비 4.5:1 을 맞추려 짙게 고침) |
| 포인트 | `#2F6F5E` | `#6FB59E` | 주 버튼, 텍스트 버튼, 선택 탭 밑줄, Claude 세로줄·머리표 |
| 포인트 위 글자 | `#F6F3EC` | `#1C1B19` | 주 버튼 글자 |
| 내 말 상자 | `#2F6F5E` | `#2F6F5E` | 내 채팅(글자 `#F6F3EC` / `#F0ECE2`) |
| 경고 | `#B4532A` | `#E08A5F` | 실패·충돌·사용량 경고 |

- 지금 파란 주 버튼(`#1B64DA`)과 흰 바탕을 위 값으로 바꾼다. 색은 모두 `Theme.swift` 의 이름 있는 색으로만 쓴다(화면 코드에 색 값 직접 금지).
- 사람별 이름 색(지금 규칙)은 유지하되, 두 모드 모두 바탕 대비가 4.5:1 이상인 값으로 다시 고른다.
- 상태 점(정상·받는 중·충돌·실패)은 포인트·보조 글자·경고 색을 쓴다.

### 2.2 글꼴

- **제목만 세리프**: 화면 제목(방 목록 "채팅방", 로그인 앱 이름)과 방 제목(머리줄)은 시스템 세리프(New York, `Font.system(design: .serif)`).
- 나머지는 지금처럼 시스템 글꼴, 코드·diff 는 고정폭. 크기 20/16/15/13/12 단계는 그대로.
- Claude 머리표 "CLAUDE"는 12 글자, 자간 넓게(0.06em 정도), 포인트 색.

### 2.3 모양

- 모서리: 버튼·카드·입력칸·말 상자 **4px**(지금 8~10px). 시트는 맥 기본 그대로.
- 그림자 없음(테두리 선으로 구분). 버튼 높이 4단계(36/28/24/텍스트)는 그대로.
- 버튼: 주 버튼 = 포인트 바탕 + 포인트 위 글자 / 보통 버튼 = 카드 바탕 + 선 테두리 / 작은 버튼 = 패널 바탕 / 텍스트 버튼 = 포인트 색 글자.
- 탭(레포·공유 파일·멤버): 선택된 탭은 글자 진하게 + 포인트 색 밑줄 2px.

### 2.4 채팅

- 내 말: 오른쪽, 내 말 상자(진녹색) 4px.
- 다른 사람 말: 왼쪽, 카드 상자 + 선 테두리 + 위에 사람별 이름 색.
- Claude 답: 말풍선 없이 **왼쪽 세로줄 2px(포인트 색) + 위에 "CLAUDE" 머리표**. 진행 표시·서브에이전트 카드·diff 카드는 카드 상자(카드 바탕 + 선)로 통일.

### 2.5 아이콘

- 앱 아이콘: 카드색 둥근 사각형 바탕에 진녹색 바통(기울인 막대 + 끝 점). SVG 원본을 `mac/Resources/icon.svg` 에 두고, 빌드 때 Swift 스크립트(`NSImage` 로 그림)와 `iconutil` 로 `.icns` 를 만든다(외부 도구 없음, 생성물은 커밋하지 않음). 어두운 모드 아이콘은 따로 두지 않는다.

## 3. 이름 바꾸기(B4)

| 대상 | 지금 | 바뀐 뒤 |
|---|---|---|
| 앱 | `~/Applications/Claude Rooms.app`, 번들 ID `dev.claude-rooms.app` | `~/Applications/Baton.app`, `dev.baton.app` |
| Swift 대상·모듈 | `mac/Sources/ClaudeRooms`, `RoomsKit`, 테스트 `RoomsKitTests` | `mac/Sources/Baton`, `BatonKit`, `BatonKitTests` |
| 화면·창 문구 | "Claude Rooms" | "Baton" (설명 문구 "팀원과 한 방에서 채팅하고 Claude에게 일을 맡겨요"는 유지) |
| 데이터 폴더 | `~/.claude-rooms` (env `ROOMS_HOME`) | `~/.baton` (env `BATON_HOME`) |
| 환경 변수 | `ROOMS_HOME·ROOMS_SCREENSHOT·ROOMS_NO_BACKGROUND·ROOMS_SERVER_PORT·ROOMS_EXIT_WITH_PARENT·ROOMS_READ_REPOS·ROOMS_APP_COMMIT·ROOMS_APPROVE_SECRET·ROOMS_APPROVE_PORT·ROOMS_SMOKE·ROOMS_SOURCE` | 같은 뒷부분에 `BATON_` |
| npm | 루트 `claude-rooms`, 공유 패키지 `@rooms/shared` 등 | `baton`, `@baton/shared` 등 |
| Info.plist 키 | `RoomsSource`, `RoomsCommit` | `BatonSource`, `BatonCommit` |
| GitHub | `izgnok/claude-rooms` | `izgnok/baton`(GitHub 이름 바꾸기 — 옛 주소는 GitHub 가 넘겨 줘서 기존 clone 의 pull 이 그대로 됨) |
| 문서 | README·user-guide·docs 의 앱 이름, 설치 명령 | `git clone https://github.com/izgnok/baton.git ~/baton` |

그대로 두는 것: 서버 프로토콜 메시지 이름(`room.*`, `rooms.changed`), 방 작업 폴더의 git 이름표 `refs/rooms/…`(기능 이름 "방"), `UserDefaults` 키 `rooms.mode.*`(번들 ID 가 바뀌어 값은 새로 시작 — 입력 모드 기억만 사라짐), 이미 clone 해 둔 소스 폴더 위치(`~/claude-rooms` 그대로 써도 됨, 앱은 Info.plist 의 소스 경로를 따른다).

### 3.1 데이터 폴더 자동 이전

코어가 시작할 때(`BATON_HOME` 을 직접 주지 않았을 때만):
1. `~/.baton` 이 없고 `~/.claude-rooms` 가 있으면 `rename` 으로 옮긴다(같은 디스크라 즉시). 옮기는 동안 다른 앱 인스턴스가 쓰지 않게, 옛 앱이 켜져 있으면(`ClaudeRooms` 프로세스) 옮기지 않고 다음 시작 때 다시 시도.
2. 옮긴 뒤 방 작업 폴더(git worktree)마다 `git -C <새 경로> worktree repair` 를 돌려 원본 레포 쪽 등록 경로를 고친다(안 하면 원본의 `git worktree list` 가 옛 경로를 가리키고 prune 때 등록이 지워진다).
3. Claude 대화 원본은 작업 폴더 경로별로 저장되지만, 실행 때마다 서버의 대화 원본을 새 경로에 다시 내려받으므로 따로 옮기지 않는다.
4. 결과를 `core.log` 에 한 줄. 실패하면 옛 폴더를 그대로 두고 `~/.baton` 을 새로 쓰지 않는다(다음 시작 때 다시 시도) — 데이터가 두 군데로 갈라지지 않게.

### 3.2 앱 바꿔 끼우기

- `npm run mac` 이 `Baton.app` 을 설치한 뒤 `~/Applications/Claude Rooms.app` 이 있으면 지운다(Dock·Spotlight 에 두 개가 남지 않게 — 아래 링크로 잠깐 대신함).
- 앱 안 업데이트: 옛 앱(Claude Rooms)이 새 소스를 받아 빌드하면 `Baton.app` 이 생긴다. 옛 앱의 다시 켜기는 자기 번들 경로를 다시 열므로, 빌드는 옛 앱 폴더를 지운 자리에 `Baton.app` 을 가리키는 심볼릭 링크를 둔다. Baton 이 켜지면 그 링크를 지운다.
- 서버와 앱 사이 프로토콜은 바뀌지 않으므로 맥마다 업데이트 시점이 달라도 함께 쓸 수 있다.

## 4. 검증

- 테스트: 데이터 폴더 이전(옛 폴더만 있음 → 옮겨지고 worktree 의 원본 쪽 등록이 새 경로 / 둘 다 있음 → 아무것도 안 함 / `BATON_HOME` 지정 → 안 함 / 실패 → 옛 폴더 유지), 환경 변수 이름, 업데이터의 다시 켜기 경로.
- 캡처: 21장을 밝게·어둡게 다시 찍어 `docs/screens-*` 교체. 색 대비(본문·보조 글자·포인트 버튼 글자) 4.5:1 이상을 캡처에서 확인.
- 맥 두 대: 옛 앱이 있는 맥2 에서 업데이트 → Baton.app 으로 바뀌고 방·대화·사본이 그대로 보임.
- 공개 레포에 회사 이름·주소·계정 정보가 없는지 다시 확인.

## 5. 순서

공유 사본 3단계(앱 연결)가 끝나 커밋된 뒤 시작한다. 이름 바꾸기와 디자인은 파일이 많이 겹치므로(Swift 전체) 이름 바꾸기 → 디자인 순으로 커밋을 나눈다. GitHub 레포 이름 바꾸기는 사용자가 확인한 뒤 마지막에 한다.
