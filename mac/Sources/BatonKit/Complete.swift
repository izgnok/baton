import Foundation

/// 입력창 자동완성의 순수 계산(`app/renderer/complete.js`). 위치는 JS 와 같이 UTF-16 단위(NSTextView 의 NSRange 와도 같다)
public enum Complete {
    public enum Kind: Sendable, Equatable { case slash, mention }

    /// start 는 `/` 또는 `@` 의 위치
    public struct Trigger: Sendable, Equatable {
        public var kind: Kind
        public var query: String
        public var start: Int
        public init(kind: Kind, query: String, start: Int) {
            self.kind = kind
            self.query = query
            self.start = start
        }
    }

    /// 팝업 한 줄. insert 는 글에 넣을 글자, source 는 출처 칩(base·user·plugin·project·member·shared·repo)
    public struct Suggestion: Sendable, Equatable {
        public var insert: String
        public var name: String
        public var desc: String
        public var source: String
        public init(insert: String, name: String, desc: String = "", source: String) {
            self.insert = insert
            self.name = name
            self.desc = desc
            self.source = source
        }
    }

    public struct Edit: Sendable, Equatable {
        public var value: String
        public var caret: Int
    }

    public static let sourceText = ["base": "기본", "user": "개인", "plugin": "플러그인", "project": "프로젝트", "member": "멤버", "shared": "공유", "repo": "레포"]
    public static let maxItems = 8
    public static let baseCommands = [Skill(name: "compact", description: "대화를 줄여요", source: "base")]

    /// 스킬·명령 한 개(listSkills 결과 한 줄)
    public struct Skill: Sendable, Equatable {
        public var name: String
        public var description: String
        public var source: String
        public init(name: String, description: String, source: String) {
            self.name = name
            self.description = description
            self.source = source
        }
    }

    /// JS 정규식 `\s` 와 같은 공백
    static func isSpace(_ u: UInt16) -> Bool {
        switch u {
        case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: true
        default: false
        }
    }

    private static func string(_ u: ArraySlice<UInt16>) -> String { String(decoding: u, as: UTF16.self) }

    /// 캐럿 앞 글자로 자동완성 종류를 정한다. 글 맨 앞(앞 공백 허용)의 / 는 명령·스킬, 단어 시작의 @ 는 멘션
    public static func detectTrigger(_ value: String, caret: Int) -> Trigger? {
        let all = Array(value.utf16)
        let before = all[0..<min(max(caret, 0), all.count)]
        // ^(\s*)/(\S*)$
        var i = before.startIndex
        while i < before.endIndex, isSpace(before[i]) { i += 1 }
        if i < before.endIndex, before[i] == 0x2F, !before[(i + 1)...].contains(where: isSpace) {
            return Trigger(kind: .slash, query: string(before[(i + 1)...]), start: i)
        }
        // (?:^|\s)@([^\s@]*)$ — 끝에서부터 공백·@ 가 아닌 글자를 거슬러 올라간다
        var j = before.endIndex
        while j > before.startIndex, !isSpace(before[j - 1]), before[j - 1] != 0x40 { j -= 1 }
        if j > before.startIndex, before[j - 1] == 0x40 {
            let at = j - 1
            if at == before.startIndex || isSpace(before[at - 1]) {
                return Trigger(kind: .mention, query: string(before[j...]), start: at)
            }
        }
        return nil
    }

    /// 고른 항목을 넣은 새 글과 캐럿. 바로 뒤가 공백이 아니면 공백 하나를 붙인다
    public static func applyChoice(_ value: String, caret: Int, trigger: Trigger, insert: String) -> Edit {
        let all = Array(value.utf16)
        let c = min(max(caret, 0), all.count)
        let start = min(max(trigger.start, 0), c)
        let tail = all[c...]
        let gap = tail.first.map(isSpace) == true ? "" : " "
        return Edit(value: string(all[0..<start]) + insert + gap + string(tail), caret: start + insert.utf16.count + 1)
    }

    /// 이름이 query 로 시작하는 것 먼저, 이름·설명에 들어 있는 것 다음. query 가 비면 그대로
    public static func rankByQuery<T>(_ items: [T], query: String, name: (T) -> String, desc: (T) -> String = { _ in "" }) -> [T] {
        let q = query.lowercased()
        if q.isEmpty { return items }
        var starts: [T] = []
        var has: [T] = []
        for it in items {
            let n = name(it).lowercased()
            if n.hasPrefix(q) { starts.append(it) }
            else if n.contains(q) || desc(it).lowercased().contains(q) { has.append(it) }
        }
        return starts + has
    }

    /// 그룹별 상한을 두고 이어 붙인다: 멤버 3, 공유 파일 3, 나머지는 레포 파일, 합쳐서 max
    public static func mergeMentionItems<T>(members: [T] = [], shared: [T] = [], repoFiles: [T] = [], max: Int = maxItems) -> [T] {
        let m = Array(members.prefix(3))
        let s = Array(shared.prefix(3))
        return Array((m + s + repoFiles.prefix(Swift.max(0, max - m.count - s.count))).prefix(max))
    }

    // MARK: 후보 만들기(complete.js 의 함수를 쓰는 autocomplete.js 의 update 와 같은 규칙)

    /// `/` 후보: 기본 명령 + 스킬을 거르고 최대 8개
    public static func slashSuggestions(skills: [Skill], query: String) -> [Suggestion] {
        rankByQuery(baseCommands + skills, query: query, name: \.name, desc: \.description)
            .prefix(maxItems)
            .map { Suggestion(insert: "/\($0.name)", name: "/\($0.name)", desc: $0.description, source: $0.source) }
    }

    public static func memberSuggestions(names: [String], query: String) -> [Suggestion] {
        rankByQuery(names, query: query, name: { $0 }).map { Suggestion(insert: "@\($0)", name: $0, source: "member") }
    }

    /// 공유 파일 경로들 → `@shared/경로`
    public static func sharedSuggestions(paths: [String], query: String) -> [Suggestion] {
        rankByQuery(paths, query: query, name: { $0 }).map { Suggestion(insert: "@shared/\($0)", name: "shared/\($0)", source: "shared") }
    }

    /// 레포 파일(listRepoFiles 결과 한 줄: 파일 이름 name, 경로 path, 글에 넣을 mention)
    public static func repoSuggestion(name: String, path: String, mention: String) -> Suggestion {
        Suggestion(insert: "@\(mention)", name: path, desc: name, source: "repo")
    }

    // MARK: 보내는 글

    /// 보내는 글이 Claude 에게 가는 글인지(맨 앞 @claude 또는 /). `shared/protocol.js` parseClaudeMention 과 같은 규칙
    public static func startsWithClaude(_ text: String) -> Bool {
        let u = Array(text.utf16)
        var i = 0
        while i < u.count, isSpace(u[i]) { i += 1 }
        guard i < u.count else { return false }
        if u[i] == 0x2F { return true }
        let rest = Array(String(decoding: u[i...], as: UTF16.self).lowercased().utf16)
        let name = Array("@claude".utf16)
        guard rest.count >= name.count, Array(rest[0..<name.count]) == name else { return false }
        return rest.count == name.count || isSpace(rest[name.count])
    }

    /// [Claude] 상태의 일반 글은 `@claude ` 를 붙여 보낸다. / 로 시작하는 글은 어느 상태든 Claude 에게 간다
    public static func outgoing(_ typed: String, toClaude: Bool) -> String {
        toClaude && !startsWithClaude(typed) ? "@claude \(typed)" : typed
    }
}
