import Foundation

/// 오른쪽 패널(레포·공유 파일·멤버)에 쓰는 문구와 목록 가공.
/// 문구는 UI 점검표(docs/2026-11-27-ui-review.md 4장)에서 바꾸기로 한 형태
public enum PanelText {
    private static let keptTexts = [
        "DIRTY": "커밋 안 한 변경", "UNPUSHED": "push 안 한 커밋", "NO_SOURCE": "원본 연결 없음", "FAILED": "정리 실패",
    ]

    /// 방 작업 폴더를 남겨 둔 사유
    public static func keptText(_ reason: String) -> String { keptTexts[reason] ?? reason }

    public struct Kept: Equatable, Sendable {
        public var name: String
        public var reason: String
        public init(name: String, reason: String) { self.name = name; self.reason = reason }
    }

    /// 방 나가기·삭제 결과: 남겨 둔 작업 폴더가 있으면 안내를 붙인다
    public static func keptNote(_ text: String, kept: [Kept]) -> String {
        guard !kept.isEmpty else { return text }
        let list = kept.map { "\($0.name)(\(keptText($0.reason)))" }.joined(separator: ", ")
        return "\(text). 방 작업 폴더 \(list)는 남겨 뒀어요"
    }

    /// "멤버 n명" (방 머리줄·공개 방 카드)
    public static func memberCountText(_ n: Int) -> String { "멤버 \(n)명" }

    /// 이 대화로 새 방 만들기 시트의 기본 이름
    public static func forkDefaultName(_ name: String) -> String { "\(name) (갈래)" }

    /// 공개 여부를 바꾼 뒤 토스트
    public static func publicToast(_ isPublic: Bool) -> String { isPublic ? "공개 방으로 바꿨어요" : "비공개 방으로 바꿨어요" }

    // MARK: 레포 카드(표시 전용)

    /// 레포 카드 상태 점
    public enum RepoDot: Equatable, Sendable { case ok, receiving, localChanges, conflict, failed }

    public static let noReposText = "Claude에게 어떤 레포로 작업할지 말해 보세요"

    /// 카드 첫 줄. 같은 이름 레포가 둘 이상이면 기준 브랜치를 붙여 구분한다(`insight · develop`)
    public static func repoTitle(name: String, baseBranch: String, sameName: Bool) -> String {
        sameName && !baseBranch.isEmpty ? "\(name) · \(baseBranch)" : name
    }

    /// 카드 둘째 줄: `기준 → 작업`, 작업 브랜치가 없으면 기준만
    public static func branchLine(baseBranch: String, workBranch: String) -> String {
        workBranch.isEmpty ? baseBranch : "\(baseBranch) → \(workBranch)"
    }

    /// 상태 점. checkRepos 결과(block·cloning)와 `local.code` 상태(ok·local_changes·conflict·failed)를 합친다
    public static func repoDot(block: String?, cloning: Bool, code: String?) -> RepoDot {
        if block == "REMOTE_MISMATCH" || code == "failed" { return .failed }
        if code == "conflict" { return .conflict }
        if cloning || block != nil { return .receiving } // 원본이 아직 없으면 곧 자동으로 받는다
        return code == "local_changes" ? .localChanges : .ok
    }

    /// 점 이름(툴팁)
    public static func repoDotLabel(_ dot: RepoDot) -> String {
        switch dot {
        case .ok: "정상"
        case .receiving: "받는 중"
        case .localChanges: "이 맥에서 고친 내용 있음"
        case .conflict: "충돌"
        case .failed: "맞추지 못함"
        }
    }

    /// 카드 아래 한 줄(정상·받는 중이면 없음)
    public static func repoNote(_ dot: RepoDot) -> String? {
        switch dot {
        case .localChanges: "이 맥에서 고친 내용이 있어요 · 다음 요청 때 함께 올라가요"
        case .conflict: "기준 브랜치와 충돌해요"
        case .failed: "맞추지 못했어요"
        case .ok, .receiving: nil
        }
    }

    /// 카드에 마우스를 올렸을 때: 원격 주소·원본·사본 경로(·처음 갈라진 브랜치는 기준과 다를 때만)
    public static func repoTooltip(remoteUrl: String, localPath: String?, worktreePath: String,
                                   baseBranch: String, originBranch: String) -> String {
        var lines = ["원격 주소: \(remoteUrl)", "원본: \(localPath ?? "이 맥에 아직 없어요 · 자동으로 받는 중")", "사본: \(worktreePath)"]
        if !originBranch.isEmpty, originBranch != baseBranch { lines.append("처음: \(originBranch)") }
        return lines.joined(separator: "\n")
    }

    /// 공유하지 못한 레포 안내(채팅 한 줄). 마지막 이름의 받침으로 조사를 고른다
    public static func tooBigText(_ names: [String]) -> String {
        let list = names.joined(separator: ", ")
        return "변경이 너무 커서 \(list)\(hasFinalConsonant(list) ? "을" : "를") 공유하지 못했어요 · push 해 주세요"
    }

    /// 한글 받침 여부. 한글이 아니면(영문·숫자 끝) 받침 없음으로 본다
    private static func hasFinalConsonant(_ word: String) -> Bool {
        guard let c = word.trimmingCharacters(in: .whitespaces).unicodeScalars.last?.value, (0xAC00...0xD7A3).contains(c) else { return false }
        return (c - 0xAC00) % 28 != 0
    }

    /// 공유 충돌 토스트
    public static func conflictToast(count: Int) -> String {
        "먼저 고친 사람이 있어 내 수정본을 따로 올렸어요 (파일 \(count)개)"
    }

    public struct SharedFile: Equatable, Sendable {
        public var path: String
        public var name: String
    }

    public struct SharedGroup: Equatable, Sendable {
        /// 폴더(끝에 / 없음). 맨 위 파일은 빈 값
        public var dir: String
        public var files: [SharedFile]
    }

    /// 경로 목록을 폴더별로 묶는다(목록 순서 유지, 같은 폴더가 이어질 때 한 묶음)
    public static func sharedGroups(_ paths: [String]) -> [SharedGroup] {
        var out: [SharedGroup] = []
        for p in paths {
            let i = p.lastIndex(of: "/")
            let dir = i.map { String(p[..<$0]) } ?? ""
            let file = SharedFile(path: p, name: i.map { String(p[p.index(after: $0)...]) } ?? p)
            if out.last?.dir == dir { out[out.count - 1].files.append(file) } else { out.append(SharedGroup(dir: dir, files: [file])) }
        }
        return out
    }

    public enum FileKind: Sendable { case markdown, html, image, pdf, other }

    private static let imageExts = ["png", "jpg", "jpeg", "gif", "webp", "heic", "bmp", "tif", "tiff", "svg"]

    public static func fileKind(_ path: String) -> FileKind {
        let l = path.lowercased()
        let ext = l.split(separator: ".").last.map(String.init) ?? ""
        if ext == "md" { return .markdown }
        if ext == "html" || ext == "htm" { return .html }
        if imageExts.contains(ext) { return .image }
        if ext == "pdf" { return .pdf }
        return .other
    }

    /// 글로 보여 줄 수 없는 파일인지(앞 8KB 에 NUL 바이트가 있으면 바이너리로 본다)
    public static func isBinary(_ data: Data) -> Bool { data.prefix(8192).contains(0) }

    /// 방 기본 모델·노력 요약(비어 있으면 "내 Claude 설정")
    public static func modelSummary(model: String, effort: String) -> String {
        let s = [Format.modelLabel(model), Format.effortLabel(effort)].filter { !$0.isEmpty }.joined(separator: " · ")
        return s.isEmpty ? "내 Claude 설정" : s
    }
}
