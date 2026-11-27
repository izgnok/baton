// 문구·시간·마크다운 변환. DOM 에 의존하지 않는다
import { Marked } from './vendor/marked.esm.js';

const ERROR_TEXT = {
  EMAIL_TAKEN: '이미 가입한 이메일이에요',
  WEAK_PASSWORD: '비밀번호는 8자 이상이에요',
  BAD_CREDENTIALS: '이메일 또는 비밀번호가 맞지 않아요',
  SERVER_UNREACHABLE: '서버에 연결할 수 없어요',
  INVALID_INPUT: '입력한 내용을 확인해 주세요',
  EMPTY_REQUEST: '요청할 내용을 함께 적어 주세요',
  NOT_FOUND: '찾을 수 없어요',
  FORBIDDEN: '이 작업을 할 수 있는 권한이 없어요',
  DISCONNECTED: '서버와 연결이 끊겨 있어요',
  UNAUTHENTICATED: '다시 로그인해 주세요',
  NOT_RETRYABLE: '다시 보낼 수 없는 요청이에요',
  DEST_EXISTS: '같은 이름의 폴더가 이미 있어요',
  CLAUDE_NOT_FOUND: '이 컴퓨터에서 claude 를 찾지 못했어요',
  CLAUDE_LOGIN_FAILED: 'Claude 로그인에 실패했어요',
  NOT_CANCELLABLE: '이미 끝났거나 중단할 수 없는 요청이에요',
  UPDATE_BUSY: 'Claude 가 실행 중이에요. 끝난 뒤 다시 눌러 주세요',
  UPDATE_LOCAL_CHANGES: '앱 소스 폴더에 커밋 안 된 변경이 있어 멈췄어요',
  UPDATE_NOT_GIT: '앱 소스 폴더가 git 클론이 아니라 업데이트할 수 없어요',
  UPDATE_PULL_FAILED: '새 버전을 받지 못했어요',
  UPDATE_INSTALL_FAILED: '패키지 설치에 실패했어요',
};

/** 화면 동작 실패 코드 → 문구 */
export const errorText = (code) => ERROR_TEXT[code] ?? `문제가 생겼어요(${code})`;

const FAIL_TEXT = {
  OFFLINE: '보낸 사람이 오프라인이라 보류했어요',
  LEFT: '보낸 사람이 방을 나가 보류했어요',
  TIMEOUT: '응답이 없어 멈췄어요',
  VERSION_MISMATCH: '다른 실행과 겹쳐 멈췄어요',
  SERVER_RESTART: '서버가 다시 시작돼 멈췄어요',
  APPLY_FAILED: '결과를 저장하지 못했어요',
  USAGE_LIMIT: 'Claude 사용량 한도에 걸렸어요',
  CLAUDE_NOT_FOUND: '이 컴퓨터에서 claude 를 찾지 못했어요',
  CLAUDE_KILLED: '실행이 중단됐어요',
  NO_RESULT: 'Claude 실행 중 오류가 났어요',
  CLAUDE_ERROR: 'Claude 실행 중 오류가 났어요',
  'PREFLIGHT:MISSING': '레포 폴더가 연결되지 않았어요',
  'PREFLIGHT:REMOTE_MISMATCH': '레포 주소가 방 설정과 달라요',
  'PREFLIGHT:BRANCH_MISMATCH': '레포 브랜치가 방 설정과 달라요',
  BRANCH_NOT_ON_REMOTE: '방 브랜치가 원격에 없어요',
  SYNC_CONFLICT: '방 작업 폴더를 최신으로 맞추다 충돌이 났어요',
  FETCH_FAILED: '원격에서 받아오지 못했어요',
  BAD_BRANCH: '브랜치 이름이 올바르지 않아요',
  WORKTREE_FAILED: '방 작업 폴더를 만들지 못했어요',
  TRANSCRIPT_MISSING: '대화 기록을 불러오지 못했어요',
  TRANSCRIPT_NOT_FOUND: '대화 기록을 불러오지 못했어요',
  BAD_SESSION_ID: '대화 기록을 불러오지 못했어요',
};

/** failed·held 요청의 error 코드 → 사유 문구 */
export function failText(code) {
  if (FAIL_TEXT[code]) return FAIL_TEXT[code];
  const m = /^CLAUDE_EXIT_(.+)$/.exec(code ?? '');
  if (m) return `Claude 가 비정상 종료했어요(${m[1]})`;
  return `실행에 실패했어요(${code ?? '알 수 없음'})`;
}

export const STATUS_TEXT = { queued: '대기 중', running: '실행 중', done: '완료', failed: '실패', held: '보류', cancelled: '중단됨' };

const pad = (n) => String(n).padStart(2, '0');
export const formatDate = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
};
export const formatTime = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** 사람별 고정 색 번호(0~5). 사용자 id 로 정한다 */
export const personIndex = (userId) => Math.abs(Number(userId) || 0) % 6;

/** 이름의 첫 글자(아바타용) */
export const initial = (name) => [...String(name ?? '').trim()][0]?.toUpperCase() ?? '?';

const DAYS = ['일', '월', '화', '수', '목', '금', '토'];

/**
 * 사용량 한 줄: "5시간 21% · 15:00 초기화" / "주간 57% · 금 14:00 초기화"
 * @param {'fiveHour'|'sevenDay'} kind
 * @param {{utilization: number, resetsAt: number}} w resetsAt 은 ms
 */
export function usageLabel(kind, w, now = Date.now()) {
  const pct = `${Math.round(w.utilization * 100)}%`;
  const name = kind === 'fiveHour' ? '5시간' : '주간';
  if (w.resetsAt <= now) return `${name} ${pct} · 초기화 시각이 지났어요`;
  const d = new Date(w.resetsAt);
  return `${name} ${pct} · ${kind === 'sevenDay' ? `${DAYS[d.getDay()]} ` : ''}${formatTime(w.resetsAt)} 초기화`;
}

/** 80% 이상이면 경고 */
export const usageWarn = (w) => w.utilization >= 0.8;

/** 마지막 확인 시각: 오늘이면 시각만, 아니면 날짜도 */
export function usageChecked(ms, now = Date.now()) {
  const same = new Date(ms).toDateString() === new Date(now).toDateString();
  return `마지막 확인 ${same ? '' : `${formatDate(ms).slice(5)} `}${formatTime(ms)}`;
}

/** 멤버 연결 요약: "연결한 레포: a, b · 함께 읽는 폴더: x · Claude 로그인 ○" */
export function memberSummary(st) {
  if (!st) return '아직 연결 정보가 없어요';
  const list = (a) => (a?.length ? a.join(', ') : '없음');
  return `연결한 레포: ${list(st.repos)} · 함께 읽는 폴더: ${list(st.readDirs)} · Claude 로그인 ${st.claude ? '○' : '×'}`;
}

/** 모델 선택 목록(정확한 모델 ID). 새 모델이 나오면 여기만 고친다 */
export const MODELS = ['claude-opus-5-5', 'claude-fable-5-2', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
const MODEL_LABEL = { opus: 'Opus(최신)', sonnet: 'Sonnet(최신)', haiku: 'Haiku(최신)', fable: 'Fable(최신)' };
const EFFORT_LABEL = { low: '낮음', medium: '보통', high: '높음', xhigh: '매우 높음', max: '최대' };
/** 모델·노력 단계 표시 이름. 빈 값은 빈 글자 */
export function modelLabel(v) {
  if (!v) return '';
  if (MODEL_LABEL[v]) return MODEL_LABEL[v];
  // claude-opus-5-5, claude-opus-5-5-20261101 → Opus 5.5
  const m = /^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8})?$/.exec(v);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : v;
}
export const effortLabel = (v) => (v ? EFFORT_LABEL[v] ?? v : '');

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 원문 HTML 은 글자로, 이미지는 대체 글자로, 링크는 http(s) 만 살린다
const marked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html: ({ text }) => escapeHtml(text),
    image: ({ text }) => escapeHtml(text),
    link({ href, tokens }) {
      const inner = this.parser.parseInline(tokens);
      return /^https?:\/\//i.test(href) ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>` : inner;
    },
  },
});

/** 마크다운 → 안전한 HTML 문자열(이 결과에만 innerHTML 을 쓴다) */
export const renderMarkdown = (text) => marked.parse(String(text ?? ''), { async: false });
