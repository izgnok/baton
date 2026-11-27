import Foundation
import Testing
@testable import RoomsKit

@Suite struct PanelTextTests {
    @Test func keptNote() {
        #expect(PanelText.keptNote("방을 삭제했어요", kept: []) == "방을 삭제했어요")
        let note = PanelText.keptNote("방에서 나왔어요", kept: [.init(name: "api", reason: "DIRTY"), .init(name: "web", reason: "X")])
        #expect(note == "방에서 나왔어요. 방 작업 폴더 api(커밋 안 한 변경), web(X)는 남겨 뒀어요")
        #expect(PanelText.repoRemovedText(keptReason: nil) == "레포를 삭제했어요")
        #expect(PanelText.repoRemovedText(keptReason: "UNPUSHED") == "레포를 삭제했어요. 방 작업 폴더는 남겨 뒀어요 (push 안 한 커밋)")
    }

    @Test func publicRoomAndForkTexts() {
        #expect(PanelText.memberCountText(1) == "멤버 1명")
        #expect(PanelText.memberCountText(12) == "멤버 12명")
        #expect(PanelText.forkDefaultName("결제 개선") == "결제 개선 (갈래)")
        #expect(PanelText.publicToast(true) == "공개 방으로 바꿨어요")
        #expect(PanelText.publicToast(false) == "비공개 방으로 바꿨어요")
    }

    @Test func repoStatus() {
        #expect(PanelText.repoStatus(block: nil, indexed: true) == (text: "정상 · 자동 연결", ok: true))
        #expect(PanelText.repoStatus(block: nil, indexed: false) == (text: "정상", ok: true))
        #expect(PanelText.repoStatus(block: "MISSING", indexed: true) == (text: "폴더 연결 필요", ok: false))
        #expect(PanelText.repoStatus(block: "REMOTE_MISMATCH", indexed: false).ok == false)
    }

    @Test func sharedGroupsAndKind() {
        let g = PanelText.sharedGroups(["a.md", "outputs/b.md", "outputs/c.html", "notes/d.txt"])
        #expect(g.map(\.dir) == ["", "outputs", "notes"])
        #expect(g[1].files.map(\.name) == ["b.md", "c.html"])
        #expect(g[1].files[0].path == "outputs/b.md")
        #expect(PanelText.sharedGroups([]).isEmpty)
        #expect(PanelText.fileKind("x/A.MD") == .markdown)
        #expect(PanelText.fileKind("r.htm") == .html)
        #expect(PanelText.fileKind("a.txt") == .other)
        #expect(PanelText.fileKind("outputs/그림.PNG") == .image)
        #expect(PanelText.fileKind("a.svg") == .image)
        #expect(PanelText.fileKind("r.pdf") == .pdf)
        #expect(PanelText.isBinary(Data([0x89, 0x50, 0x4E, 0x47, 0x00, 0x1A])))
        #expect(!PanelText.isBinary(Data("한글 글".utf8)))
    }

    @Test func conflictAndModelSummary() {
        #expect(PanelText.conflictToast(count: 2) == "먼저 고친 사람이 있어 내 수정본을 따로 올렸어요 (파일 2개)")
        #expect(PanelText.modelSummary(model: "claude-opus-5-5", effort: "high") == "Opus 5.5 · 높음")
        #expect(PanelText.modelSummary(model: "", effort: "") == "내 Claude 설정")
    }
}
