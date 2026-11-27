import Foundation

/// 승인 창에 보여 줄 도구 입력을 사람이 읽는 형태로 바꾼다(UI 점검표 AP1~AP3)
public enum ApprovalText {
    public struct Field: Equatable, Sendable {
        public var label: String
        public var value: String
    }

    public enum Body: Equatable, Sendable {
        /// 파일 내용처럼 줄바꿈이 있는 글
        case text(String)
        case command(String)
        case fields([Field])
        case none
    }

    public struct Summary: Equatable, Sendable {
        public var toolLabel: String
        public var toolName: String
        /// 홈 폴더를 `~` 로 줄인 경로(없으면 nil)
        public var path: String?
        public var fullPath: String?
        public var body: Body
    }

    public static func summary(name: String?, input: JSON?, home: String = NSHomeDirectory()) -> Summary {
        let str = { (k: String) in input?[k]?.string ?? "" }
        let fullPath = ["file_path", "notebook_path", "path"].map(str).first { !$0.isEmpty }
        let fields = { (items: [(String, String)]) -> Body in
            let f = items.filter { !$0.1.isEmpty }.map { Field(label: $0.0, value: clip($0.1, limit: 300)) }
            return f.isEmpty ? .none : .fields(f)
        }
        let body: Body
        switch name {
        case "Write": body = str("content").isEmpty ? .none : .text(clip(str("content"), limit: 4000))
        case "NotebookEdit": body = str("new_source").isEmpty ? .none : .text(clip(str("new_source"), limit: 4000))
        case "Edit": body = fields([("바꾸기 전", str("old_string")), ("바꾼 뒤", str("new_string"))])
        case "MultiEdit": body = fields([("수정", input?["edits"]?.array.map { "\($0.count)곳" } ?? "")])
        case "Bash": body = str("command").isEmpty ? .none : .command(clip(str("command"), limit: 2000))
        case "Read": body = .none
        case "Grep": body = fields([("찾을 내용", str("pattern"))])
        case "Glob": body = fields([("파일 이름", str("pattern"))])
        case "WebFetch": body = fields([("주소", str("url"))])
        case "WebSearch": body = fields([("검색어", str("query"))])
        case "Task": body = fields([("할 일", str("description"))])
        default: body = fields(scalars(input))
        }
        return Summary(
            toolLabel: ToolText.label(name), toolName: name ?? "",
            path: fullPath.map { ToolText.shortPath($0, home: home) }, fullPath: fullPath, body: body)
    }

    /// 모르는 도구: 맨 위 단계의 글·숫자·참거짓 값을 이름순으로 최대 4개
    private static func scalars(_ input: JSON?) -> [(String, String)] {
        guard case .object(let o)? = input else { return [] }
        var out: [(String, String)] = []
        for k in o.keys.sorted() where out.count < 4 {
            switch o[k] {
            case .string(let s)?: out.append((k, s))
            case .number(let n)?: out.append((k, n == n.rounded() && abs(n) < 9e15 ? String(Int(n)) : String(n)))
            case .bool(let b)?: out.append((k, b ? "true" : "false"))
            default: break
            }
        }
        return out
    }

    public static func clip(_ s: String, limit: Int) -> String {
        s.count > limit ? "\(s.prefix(limit))\n… (\(s.count - limit)자 더 있음)" : s
    }

    /// 입력 전체 JSON 원문(기본 2000자까지)
    public static func prettyJSON(_ input: JSON?, limit: Int = 2000) -> String {
        guard let input else { return "" }
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        let s = (try? enc.encode(input)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
        return clip(s, limit: limit)
    }
}
