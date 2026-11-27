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

    /// 레포 삭제 결과 토스트
    public static func repoRemovedText(keptReason: String?) -> String {
        guard let keptReason else { return "레포를 삭제했어요" }
        return "레포를 삭제했어요. 방 작업 폴더는 남겨 뒀어요 (\(keptText(keptReason)))"
    }

    /// "멤버 n명" (방 머리줄·공개 방 카드)
    public static func memberCountText(_ n: Int) -> String { "멤버 \(n)명" }

    /// 이 대화로 새 방 만들기 시트의 기본 이름
    public static func forkDefaultName(_ name: String) -> String { "\(name) (갈래)" }

    /// 공개 여부를 바꾼 뒤 토스트
    public static func publicToast(_ isPublic: Bool) -> String { isPublic ? "공개 방으로 바꿨어요" : "비공개 방으로 바꿨어요" }

    /// 레포 카드 상태 한 줄 (RP4). ok 면 정상, 아니면 위험 글자
    public static func repoStatus(block: String?, indexed: Bool) -> (text: String, ok: Bool) {
        switch block {
        case "MISSING": ("폴더 연결 필요", false)
        case "REMOTE_MISMATCH": ("고른 폴더의 원격 주소가 달라요", false)
        case let b?: (b, false)
        case nil: (indexed ? "정상 · 자동 연결" : "정상", true)
        }
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
