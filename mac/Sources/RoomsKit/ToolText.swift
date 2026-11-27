import Foundation

/// 채팅의 도구 호출 줄·승인 대기 문구에 쓰는 한국어 이름과 한 줄 요약(UI 점검표 CH6)
public enum ToolText {
    private static let labels: [String: String] = [
        "Write": "파일 쓰기", "Edit": "파일 고치기", "MultiEdit": "파일 고치기", "Read": "파일 읽기",
        "Bash": "명령 실행", "Grep": "내용 찾기", "Glob": "파일 찾기",
        "WebFetch": "웹 페이지 읽기", "WebSearch": "웹 검색", "NotebookEdit": "노트북 고치기",
        "Task": "하위 작업", "TodoWrite": "할 일 정리",
    ]

    /// 도구 이름 → 화면 이름. 표에 없으면 원래 이름
    public static func label(_ name: String?) -> String {
        guard let name, !name.isEmpty else { return "도구" }
        return labels[name] ?? name
    }

    /// 홈 폴더로 시작하면 `~` 로 줄인다
    public static func shortPath(_ path: String, home: String = NSHomeDirectory()) -> String {
        guard !home.isEmpty, home != "/" else { return path }
        if path == home { return "~" }
        return path.hasPrefix(home + "/") ? "~" + path.dropFirst(home.count) : path
    }

    /// (이름, 뒤에 붙는 값). 값은 한 줄이며 길이는 자르지 않는다(화면이 말줄임)
    public static func summary(name: String?, input: JSON?) -> (label: String, detail: String) {
        let text = { (key: String) in input?[key]?.string ?? "" }
        let detail: String
        switch name {
        case "Write", "Edit", "MultiEdit", "Read": detail = shortPath(text("file_path"))
        case "NotebookEdit": detail = shortPath(text("notebook_path"))
        case "Bash": detail = text("command")
        case "Grep", "Glob": detail = text("pattern")
        case "WebFetch": detail = text("url")
        case "WebSearch": detail = text("query")
        case "Task": detail = text("description")
        default: detail = ""
        }
        return (label(name), detail.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.joined(separator: " "))
    }
}
