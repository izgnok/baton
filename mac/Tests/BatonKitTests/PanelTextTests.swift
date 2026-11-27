import Foundation
import Testing
@testable import BatonKit

@Suite struct PanelTextTests {
    @Test func keptNote() {
        #expect(PanelText.keptNote("방을 삭제했어요", kept: []) == "방을 삭제했어요")
        let note = PanelText.keptNote("방에서 나왔어요", kept: [.init(name: "api", reason: "DIRTY"), .init(name: "web", reason: "X")])
        #expect(note == "방에서 나왔어요. 방 작업 폴더 api(커밋 안 한 변경), web(X)는 남겨 뒀어요")
    }

    @Test func publicRoomAndForkTexts() {
        #expect(PanelText.memberCountText(1) == "멤버 1명")
        #expect(PanelText.memberCountText(12) == "멤버 12명")
        #expect(PanelText.forkDefaultName("결제 개선") == "결제 개선 (갈래)")
        #expect(PanelText.publicToast(true) == "공개 방으로 바꿨어요")
        #expect(PanelText.publicToast(false) == "비공개 방으로 바꿨어요")
    }

    @Test func repoCardTexts() {
        // 같은 이름 레포가 둘 이상이면 기준 브랜치를 붙여 구분, 하나뿐이면 이름만
        #expect(PanelText.repoTitle(name: "insight", baseBranch: "develop", sameName: true) == "insight · develop")
        #expect(PanelText.repoTitle(name: "insight", baseBranch: "develop", sameName: false) == "insight")
        // 작업 브랜치가 없으면 기준만
        #expect(PanelText.branchLine(baseBranch: "release/15.7.0", workBranch: "feature/X") == "release/15.7.0 → feature/X")
        #expect(PanelText.branchLine(baseBranch: "develop", workBranch: "") == "develop")
    }

    @Test func repoDotAndNote() {
        #expect(PanelText.repoDot(block: nil, cloning: false, code: nil) == .ok)
        #expect(PanelText.repoDot(block: nil, cloning: false, code: "ok") == .ok)
        #expect(PanelText.repoDot(block: nil, cloning: true, code: nil) == .receiving)
        #expect(PanelText.repoDot(block: "MISSING", cloning: false, code: nil) == .receiving)
        #expect(PanelText.repoDot(block: nil, cloning: false, code: "local_changes") == .localChanges)
        #expect(PanelText.repoDot(block: nil, cloning: false, code: "conflict") == .conflict)
        #expect(PanelText.repoDot(block: nil, cloning: false, code: "failed") == .failed)
        #expect(PanelText.repoDot(block: "REMOTE_MISMATCH", cloning: false, code: nil) == .failed)
        // 충돌·실패는 받는 중·고친 내용보다 먼저 보인다
        #expect(PanelText.repoDot(block: nil, cloning: true, code: "conflict") == .conflict)
        #expect(PanelText.repoNote(.localChanges) == "이 맥에서 고친 내용이 있어요 · 다음 요청 때 함께 올라가요")
        #expect(PanelText.repoNote(.conflict) == "기준 브랜치와 충돌해요")
        #expect(PanelText.repoNote(.failed) == "맞추지 못했어요")
        #expect(PanelText.repoNote(.ok) == nil)
        #expect(PanelText.repoNote(.receiving) == nil)
        #expect(PanelText.noReposText == "Claude에게 어떤 레포로 작업할지 말해 보세요")
    }

    @Test func repoTooltip() {
        let same = PanelText.repoTooltip(remoteUrl: "git@h:a/r.git", localPath: "/Users/me/r", worktreePath: "/Users/me/.baton/1/repos/1-r",
                                         baseBranch: "release/15.7.0", originBranch: "release/15.7.0")
        #expect(same == "원격 주소: git@h:a/r.git\n원본: /Users/me/r\n사본: /Users/me/.baton/1/repos/1-r")
        // 원본이 아직 없고 처음 갈라진 브랜치가 기준과 다르면 둘 다 보인다
        let moved = PanelText.repoTooltip(remoteUrl: "u", localPath: nil, worktreePath: "/w", baseBranch: "feature/X", originBranch: "release/15.7.0")
        #expect(moved == "원격 주소: u\n원본: 이 맥에 아직 없어요 · 자동으로 받는 중\n사본: /w\n처음: release/15.7.0")
    }

    @Test func tooBigTextParticle() {
        #expect(PanelText.tooBigText(["insight"]) == "변경이 너무 커서 insight를 공유하지 못했어요 · push 해 주세요")
        #expect(PanelText.tooBigText(["insight", "web"]) == "변경이 너무 커서 insight, web를 공유하지 못했어요 · push 해 주세요")
        #expect(PanelText.tooBigText(["결제앱"]) == "변경이 너무 커서 결제앱을 공유하지 못했어요 · push 해 주세요")
        #expect(PanelText.tooBigText(["결제서비스", "회원"]) == "변경이 너무 커서 결제서비스, 회원을 공유하지 못했어요 · push 해 주세요")
        #expect(PanelText.tooBigText(["결제"]) == "변경이 너무 커서 결제를 공유하지 못했어요 · push 해 주세요")
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
