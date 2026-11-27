import Foundation

public struct UsageWindow: Equatable, Sendable {
    public var utilization: Double
    /// 초기화 시각(ms)
    public var resetsAt: Double

    public init(utilization: Double, resetsAt: Double) {
        self.utilization = utilization
        self.resetsAt = resetsAt
    }

    public init?(_ json: JSON?) {
        guard case .number(let u)? = json?["utilization"] else { return nil }
        self.init(utilization: u, resetsAt: { if case .number(let r)? = json?["resetsAt"] { r } else { 0 } }())
    }
}

public enum UsageKind: Sendable { case fiveHour, sevenDay }

public struct MemberStatus: Equatable, Sendable {
    public var repos: [String]
    public var readDirs: [String]
    public var claude: Bool

    public init(repos: [String] = [], readDirs: [String] = [], claude: Bool = false) {
        self.repos = repos
        self.readDirs = readDirs
        self.claude = claude
    }
}

/// 화면에 쓰는 문구·시간 변환. 결과는 `app/renderer/format.js` 와 같되,
/// UI 점검표(docs/2026-11-27-ui-review.md 4장)에서 바꾸기로 한 문구는 바뀐 것으로 낸다.
public enum Format {
    private static let errorTexts: [String: String] = [
        "EMAIL_TAKEN": "이미 가입한 이메일이에요",
        "WEAK_PASSWORD": "비밀번호는 8자 이상이에요",
        "BAD_CREDENTIALS": "이메일 또는 비밀번호가 맞지 않아요",
        "SERVER_UNREACHABLE": "서버에 연결할 수 없어요",
        "INVALID_INPUT": "입력한 내용을 확인해 주세요",
        "EMPTY_REQUEST": "요청할 내용을 함께 적어 주세요",
        "NOT_FOUND": "찾을 수 없어요",
        "FORBIDDEN": "이 작업을 할 수 있는 권한이 없어요",
        "DISCONNECTED": "서버와 연결이 끊겨 있어요",
        "UNAUTHENTICATED": "다시 로그인해 주세요",
        "NOT_RETRYABLE": "다시 보낼 수 없는 요청이에요",
        "DEST_EXISTS": "같은 이름의 폴더가 이미 있어요",
        "CLAUDE_NOT_FOUND": "이 컴퓨터에서 claude를 찾지 못했어요",
        "CLAUDE_LOGIN_FAILED": "Claude 로그인에 실패했어요",
        "NOT_CANCELLABLE": "이미 끝났거나 중단할 수 없는 요청이에요",
        "UPDATE_BUSY": "Claude가 실행 중이에요. 끝난 뒤 다시 눌러 주세요",
        "UPDATE_LOCAL_CHANGES": "앱 소스 폴더에 커밋 안 된 변경이 있어 멈췄어요",
        "UPDATE_NOT_GIT": "앱 소스 폴더가 git 클론이 아니라 업데이트할 수 없어요",
        "UPDATE_PULL_FAILED": "새 버전을 받지 못했어요",
        "UPDATE_INSTALL_FAILED": "패키지 설치에 실패했어요",
        "UPDATE_BUILD_FAILED": "앱을 빌드하지 못했어요. 지금 버전을 그대로 써요(로그 ~/.claude-rooms/core.log)",
    ]

    /// 화면 동작 실패 코드 → 문구
    public static func errorText(_ code: String) -> String {
        errorTexts[code] ?? "문제가 생겼어요(\(code))"
    }

    private static let failTexts: [String: String] = [
        "OFFLINE": "보낸 사람이 오프라인이라 보류했어요",
        "LEFT": "보낸 사람이 방을 나가 보류했어요",
        "TIMEOUT": "응답이 없어 멈췄어요",
        "VERSION_MISMATCH": "다른 실행과 겹쳐 멈췄어요",
        "SERVER_RESTART": "서버가 다시 시작돼 멈췄어요",
        "APPLY_FAILED": "결과를 저장하지 못했어요",
        "USAGE_LIMIT": "Claude 사용량 한도에 걸렸어요",
        "CLAUDE_NOT_FOUND": "이 컴퓨터에서 claude를 찾지 못했어요",
        "CLAUDE_KILLED": "실행이 중단됐어요",
        "NO_RESULT": "Claude 실행 중 오류가 났어요",
        "CLAUDE_ERROR": "Claude 실행 중 오류가 났어요",
        "PREFLIGHT:MISSING": "레포 폴더가 연결되지 않았어요",
        "PREFLIGHT:REMOTE_MISMATCH": "레포 주소가 방 설정과 달라요",
        "PREFLIGHT:BRANCH_MISMATCH": "레포 브랜치가 방 설정과 달라요",
        "BRANCH_NOT_ON_REMOTE": "방 브랜치가 원격에 없어요",
        "SYNC_CONFLICT": "방 작업 폴더를 최신으로 맞추다 충돌이 났어요",
        "FETCH_FAILED": "원격에서 받아오지 못했어요",
        "BAD_BRANCH": "브랜치 이름이 올바르지 않아요",
        "WORKTREE_FAILED": "방 작업 폴더를 만들지 못했어요",
        "TRANSCRIPT_MISSING": "대화 기록을 불러오지 못했어요",
        "TRANSCRIPT_NOT_FOUND": "대화 기록을 불러오지 못했어요",
        "BAD_SESSION_ID": "대화 기록을 불러오지 못했어요",
    ]

    /// failed·held 요청의 error 코드 → 사유 문구
    public static func failText(_ code: String?) -> String {
        if let code, let t = failTexts[code] { return t }
        if let code, code.hasPrefix("CLAUDE_EXIT_"), code.count > "CLAUDE_EXIT_".count {
            return "Claude가 비정상 종료했어요(\(code.dropFirst("CLAUDE_EXIT_".count)))"
        }
        return "실행에 실패했어요(\(code ?? "알 수 없음"))"
    }

    public static let statusText: [String: String] = [
        "queued": "대기 중", "running": "실행 중", "done": "완료", "failed": "실패", "held": "보류", "cancelled": "중단됨",
    ]

    private static func date(_ ms: Double) -> Date { Date(timeIntervalSince1970: ms / 1000) }
    private static func two(_ n: Int) -> String { n < 10 ? "0\(n)" : "\(n)" }

    /// 2026.11.27
    public static func formatDate(_ ms: Double) -> String {
        let c = Calendar.current.dateComponents([.year, .month, .day], from: date(ms))
        return "\(c.year!).\(two(c.month!)).\(two(c.day!))"
    }

    /// 09:05
    public static func formatTime(_ ms: Double) -> String {
        let c = Calendar.current.dateComponents([.hour, .minute], from: date(ms))
        return "\(two(c.hour!)):\(two(c.minute!))"
    }

    /// 방 카드: "11월 27일에 만들었어요"
    public static func createdText(_ ms: Double) -> String {
        let c = Calendar.current.dateComponents([.month, .day], from: date(ms))
        return "\(c.month!)월 \(c.day!)일에 만들었어요"
    }

    /// 사람별 고정 색 번호(0~5). 사용자 id 로 정한다
    public static func personIndex(_ userID: Int) -> Int { abs(userID) % 6 }
    public static func personIndex(_ userID: String) -> Int { personIndex(Int(userID) ?? 0) }

    /// 이름의 첫 글자(아바타용)
    public static func initial(_ name: String?) -> String {
        guard let ch = (name ?? "").trimmingCharacters(in: .whitespacesAndNewlines).first else { return "?" }
        return String(ch).uppercased()
    }

    private static let dayNames = ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"]

    /// "5시간 21% · 15:00 초기화" / "주간 57% · 금요일 14:00 초기화"
    public static func usageLabel(_ kind: UsageKind, _ w: UsageWindow, now: Double = Date().timeIntervalSince1970 * 1000) -> String {
        let pct = "\(Int((w.utilization * 100).rounded()))%"
        let name = kind == .fiveHour ? "5시간" : "주간"
        if w.resetsAt <= now { return "\(name) \(pct) · 초기화 시각이 지났어요" }
        let day = kind == .sevenDay ? dayNames[Calendar.current.component(.weekday, from: date(w.resetsAt)) - 1] + " " : ""
        return "\(name) \(pct) · \(day)\(formatTime(w.resetsAt)) 초기화"
    }

    /// 80% 이상이면 경고
    public static func usageWarn(_ w: UsageWindow) -> Bool { w.utilization >= 0.8 }

    /// 마지막 확인 시각: 오늘이면 시각만, 아니면 날짜도
    public static func usageChecked(_ ms: Double, now: Double = Date().timeIntervalSince1970 * 1000) -> String {
        let same = Calendar.current.isDate(date(ms), inSameDayAs: date(now))
        return "마지막 확인 \(same ? "" : "\(formatDate(ms).dropFirst(5)) ")\(formatTime(ms))"
    }

    /// 멤버 연결 요약 줄(이름표 붙음): ["레포 a, b", "읽는 폴더 x", "Claude 로그인됨"]
    public static func memberSummaryLines(_ st: MemberStatus?) -> [String] {
        guard let st else { return ["아직 연결 정보가 없어요"] }
        let list = { (a: [String]) in a.isEmpty ? "없음" : a.joined(separator: ", ") }
        return ["레포 \(list(st.repos))", "읽는 폴더 \(list(st.readDirs))", st.claude ? "Claude 로그인됨" : "Claude 로그인 안 됨"]
    }

    /// "레포 a, b / 읽는 폴더 x / Claude 로그인됨"
    public static func memberSummary(_ st: MemberStatus?) -> String {
        memberSummaryLines(st).joined(separator: " / ")
    }

    /// 모델 선택 목록(정확한 모델 ID). 새 모델이 나오면 여기만 고친다
    public static let models = ["claude-opus-5-5", "claude-fable-5-2", "claude-sonnet-5-5", "claude-haiku-5-5"]
    private static let modelLabels = ["opus": "Opus(최신)", "sonnet": "Sonnet(최신)", "haiku": "Haiku(최신)", "fable": "Fable(최신)"]
    private static let effortLabels = ["low": "낮음", "medium": "보통", "high": "높음", "xhigh": "매우 높음", "max": "최대"]

    /// 모델의 컨텍스트 창(토큰). 지금 고를 수 있는 모델은 모두 100만, 모르는 모델도 100만으로 본다
    public static func contextWindow(_ model: String?) -> Int {
        model?.hasPrefix("claude-haiku-4") == true ? 200_000 : 1_000_000
    }

    /// 토큰 수를 짧게: 9,500 / 14.5만 / 100만
    public static func tokenCount(_ n: Int) -> String {
        if n < 10_000 { return n.formatted(.number.grouping(.automatic).locale(Locale(identifier: "en_US"))) }
        let man = Double(n) / 10_000
        let s = man >= 100 || man == man.rounded() ? String(Int(man.rounded())) : String(format: "%.1f", man)
        return "\(s)만"
    }

    /// 방 컨텍스트: "컨텍스트 15% · 14.5만/100만". 0보다 크면 최소 1%
    public static func contextLabel(tokens: Int, model: String?) -> String {
        let window = contextWindow(model)
        let pct = tokens > 0 ? max(1, Int((Double(tokens) / Double(window) * 100).rounded())) : 0
        return "컨텍스트 \(pct)% · \(tokenCount(tokens))/\(tokenCount(window))"
    }

    /// 모델 표시 이름. 빈 값은 빈 글자
    public static func modelLabel(_ v: String?) -> String {
        guard let v, !v.isEmpty, v != "<synthetic>" else { return "" }
        if let l = modelLabels[v] { return l }
        // claude-opus-5-5, claude-opus-5-5-20261101 → Opus 5.5
        let p = v.split(separator: "-", omittingEmptySubsequences: false).map(String.init)
        let digits = { (s: String) in !s.isEmpty && s.allSatisfy { $0.isASCII && $0.isNumber } }
        guard (p.count == 4 || (p.count == 5 && p[4].count == 8 && digits(p[4]))), p[0] == "claude",
              !p[1].isEmpty, p[1].allSatisfy({ $0.isASCII && $0.isLowercase }), digits(p[2]), digits(p[3]) else { return v }
        return "\(p[1].prefix(1).uppercased())\(p[1].dropFirst()) \(p[2]).\(p[3])"
    }

    /// 노력 단계 표시 이름
    public static func effortLabel(_ v: String?) -> String {
        guard let v, !v.isEmpty else { return "" }
        return effortLabels[v] ?? v
    }
}
