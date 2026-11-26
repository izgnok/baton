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

export const STATUS_TEXT = { queued: '대기 중', running: '실행 중', done: '완료', failed: '실패', held: '보류' };

const pad = (n) => String(n).padStart(2, '0');
export const formatDate = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
};
export const formatTime = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

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
