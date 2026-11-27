import Foundation

/// stream-json 이벤트 한 조각(assistant 메시지의 블록 하나, 도구 결과 하나 등). `parent` 가 있으면 서브에이전트 안의 일이다
public struct RunEvent: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case thinking
        case text
        case toolUse(id: String, name: String, input: JSON)
        /// asyncLaunch: 서브에이전트를 백그라운드로 띄웠다는 즉시 결과(일이 끝난 게 아니다)
        case toolResult(toolUseId: String, asyncLaunch: Bool)
        /// system/task_notification(서브에이전트 끝남)
        case taskDone(toolUseId: String)
    }

    /// 화면 조각 key 와 같은 "<메시지 id>:<블록 번호>"
    public var key: String
    public var parent: String?
    /// 서버가 받은 시각(ms)
    public var at: Double
    public var kind: Kind

    public init(key: String, parent: String?, at: Double, kind: Kind) {
        self.key = key
        self.parent = parent
        self.at = at
        self.kind = kind
    }

    /// claude 이벤트 하나를 조각으로 푼다
    public static func parse(_ ev: JSON, id: Int, at: Double) -> [RunEvent] {
        let parent = ev["parent_tool_use_id"]?.string
        func make(_ i: Int, _ kind: Kind) -> RunEvent { RunEvent(key: "\(id):\(i)", parent: parent, at: at, kind: kind) }
        switch ev["type"]?.string {
        case "assistant":
            let content = ev["message"]?["content"]
            if content?.string != nil { return [make(0, .text)] }
            return (content?.array ?? []).enumerated().compactMap { i, c in
                switch c["type"]?.string {
                case "thinking": make(i, .thinking)
                case "text": make(i, .text)
                case "tool_use": make(i, .toolUse(id: c["id"]?.string ?? "", name: c["name"]?.string ?? "", input: c["input"] ?? .null))
                default: nil
                }
            }
        case "user":
            return (ev["message"]?["content"]?.array ?? []).enumerated().compactMap { i, c in
                guard c["type"]?.string == "tool_result", let uid = c["tool_use_id"]?.string else { return nil }
                let body = c["content"]
                let text = body?.string ?? body?.array?.first?["text"]?.string ?? ""
                return make(i, .toolResult(toolUseId: uid, asyncLaunch: text.hasPrefix("Async agent launched")))
            }
        case "system":
            guard ev["subtype"]?.string == "task_notification", let uid = ev["tool_use_id"]?.string else { return [] }
            return [make(0, .taskDone(toolUseId: uid))]
        default:
            return []
        }
    }
}

/// 실행 중 "지금 단계" 한 줄, 생각 시간, 서브에이전트 묶기(화면과 무관한 순수 함수)
public enum RunProgress {
    public enum Step: Equatable, Sendable {
        case thinking
        case tool(name: String, detail: String)
        case subagents(Int)

        public var label: String {
            switch self {
            case .thinking: "생각하는 중…"
            case .subagents(let n): "서브에이전트 \(n)개 작업 중"
            case .tool(let name, _): RunProgress.verbs[name] ?? "\(ToolText.label(name)) 실행 중"
            }
        }

        public var detail: String {
            if case .tool(_, let d) = self { d } else { "" }
        }
    }

    private static let verbs: [String: String] = [
        "Read": "파일 읽는 중", "Write": "파일 쓰는 중", "Edit": "파일 고치는 중", "MultiEdit": "파일 고치는 중",
        "Bash": "명령 실행 중", "Grep": "내용 찾는 중", "Glob": "파일 찾는 중",
        "WebFetch": "웹 페이지 읽는 중", "WebSearch": "웹 검색 중", "NotebookEdit": "노트북 고치는 중", "TodoWrite": "할 일 정리하는 중",
    ]

    /// 서브에이전트를 띄우는 도구(이름이 Task 였다가 Agent 로 바뀌었다)
    public static func isAgentTool(_ name: String?) -> Bool { name == "Task" || name == "Agent" }

    /// 서브에이전트 카드 머리에 쓰는 이름. 설명이 없으면 종류
    public static func agentTitle(_ input: JSON?) -> String {
        let pick = { (k: String) in input?[k]?.string.flatMap { $0.isEmpty ? nil : $0 } }
        return pick("description") ?? pick("subagent_type") ?? ""
    }

    /// 끝난 도구 호출 id. 서브에이전트를 백그라운드로 띄운 즉시 결과는 끝난 것으로 치지 않는다(task_notification 이 와야 끝)
    public static func finishedToolIds(_ events: [RunEvent]) -> Set<String> {
        var done = Set<String>()
        for e in events {
            switch e.kind {
            case .toolResult(let id, let asyncLaunch): if !asyncLaunch { done.insert(id) }
            case .taskDone(let id): done.insert(id)
            default: break
            }
        }
        return done
    }

    /// 지금 단계: 결과가 안 온 마지막 도구 → 없으면 아직 안 끝난 서브에이전트 수 → 없으면 생각 중
    public static func step(_ events: [RunEvent]) -> Step {
        let done = finishedToolIds(events)
        var tool: Step?
        var agents = 0
        for e in events {
            guard case .toolUse(let id, let name, let input) = e.kind, !done.contains(id) else { continue }
            if isAgentTool(name) { agents += 1 }
            else if e.parent == nil { tool = .tool(name: name, detail: ToolText.summary(name: name, input: input).detail) }
        }
        return tool ?? (agents > 0 ? .subagents(agents) : .thinking)
    }

    /// "12초" · "1분 5초"
    public static func elapsedText(_ seconds: Int) -> String {
        let s = max(0, seconds)
        if s < 60 { return "\(s)초" }
        return s % 60 == 0 ? "\(s / 60)분" : "\(s / 60)분 \(s % 60)초"
    }

    /// 생각 블록 key → 걸린 초. stream-json 은 생각이 끝난 뒤에 블록을 보내므로,
    /// 같은 범위(최상위 또는 같은 서브에이전트)의 바로 앞 이벤트부터 이 이벤트까지를 잰다. 1초 미만이거나 앞 이벤트가 없으면 빠진다
    public static func thinkingSeconds(_ events: [RunEvent]) -> [String: Int] {
        var last: [String: Double] = [:]
        var out: [String: Int] = [:]
        for e in events {
            let scope = e.parent ?? ""
            if case .thinking = e.kind, let prev = last[scope] {
                let s = Int(((e.at - prev) / 1000).rounded())
                if s >= 1 { out[e.key] = s }
            }
            last[scope] = e.at
        }
        return out
    }

    /// parent 가 parents 에 있는 항목을 그 부모 아래로 모으고(순서 유지) 나머지는 최상위에 둔다. 부모를 모르는 고아도 최상위
    public static func groupByParent<T>(_ items: [T], parent: (T) -> String?, parents: Set<String>) -> (top: [T], children: [String: [T]]) {
        var top: [T] = []
        var children: [String: [T]] = [:]
        for item in items {
            if let p = parent(item), parents.contains(p) { children[p, default: []].append(item) } else { top.append(item) }
        }
        return (top, children)
    }
}
