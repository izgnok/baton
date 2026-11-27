import Foundation
import Testing
@testable import BatonKit

@Suite struct PreviewTextTests {
    @Test func shortFileIsKept() {
        let r = PreviewText.decode(Data("안녕".utf8), limit: 100)
        #expect(r.text == "안녕")
        #expect(!r.cut)
    }

    @Test func cutNeverSplitsAKoreanCharacter() {
        let data = Data(String(repeating: "한", count: 10).utf8) // 30바이트, 글자마다 3바이트
        for limit in 7...8 {
            let r = PreviewText.decode(data, limit: limit)
            #expect(r.cut)
            #expect(r.text == "한한")
            #expect(!r.text.contains("\u{FFFD}"))
        }
        #expect(PreviewText.decode(data, limit: 9).text == "한한한")
        #expect(PreviewText.decode(data, limit: 12).text == "한한한한")
    }

    @Test func folderAndName() {
        #expect(PreviewText.folder("outputs/정리.md") == "outputs/")
        #expect(PreviewText.folder("a/b/c.txt") == "a/b/")
        #expect(PreviewText.folder("c.txt") == "")
        #expect(PreviewText.name("a/b/c.txt") == "c.txt")
        #expect(PreviewText.name("c.txt") == "c.txt")
    }
}

@Suite struct ApprovalTextTests {
    @Test func writeShowsContentAndShortPath() {
        let s = ApprovalText.summary(
            name: "Write", input: .object(["file_path": .string("/Users/me/r/a.md"), "content": .string("# 제목\n- 내용")]), home: "/Users/me")
        #expect(s.toolLabel == "파일 쓰기")
        #expect(s.toolName == "Write")
        #expect(s.path == "~/r/a.md")
        #expect(s.fullPath == "/Users/me/r/a.md")
        #expect(s.body == .text("# 제목\n- 내용"))
    }

    @Test func bashShowsOnlyCommand() {
        let s = ApprovalText.summary(name: "Bash", input: .object(["command": .string("ls -la"), "description": .string("목록")]))
        #expect(s.body == .command("ls -la"))
        #expect(s.path == nil)
    }

    @Test func editShowsBeforeAndAfter() {
        let s = ApprovalText.summary(name: "Edit", input: .object(["file_path": .string("/x/a.js"), "old_string": .string("a"), "new_string": .string("b")]))
        #expect(s.body == .fields([.init(label: "바꾸기 전", value: "a"), .init(label: "바꾼 뒤", value: "b")]))
    }

    @Test func unknownToolListsScalarFields() {
        let s = ApprovalText.summary(name: "Custom", input: .object(["b": .number(3), "a": .string("x"), "n": .object([:]), "c": .bool(true)]))
        #expect(s.toolLabel == "Custom")
        #expect(s.body == .fields([.init(label: "a", value: "x"), .init(label: "b", value: "3"), .init(label: "c", value: "true")]))
        #expect(ApprovalText.summary(name: "Read", input: .object(["file_path": .string("/x")])).body == .none)
        #expect(ApprovalText.summary(name: nil, input: nil).body == .none)
    }

    @Test func clipAndJSON() {
        #expect(ApprovalText.clip("abc", limit: 5) == "abc")
        #expect(ApprovalText.clip("abcdef", limit: 4) == "abcd\n… (2자 더 있음)")
        let j = ApprovalText.prettyJSON(.object(["b": .string("a/b"), "a": .number(1)]))
        #expect(j == "{\n  \"a\" : 1,\n  \"b\" : \"a/b\"\n}")
    }
}

@Suite struct SheetPolicyTests {
    @Test func readOnlySheetsCloseAndInputSheetsWait() {
        #expect(SheetPolicy.onApproval(open: .none) == .showNow)
        #expect(SheetPolicy.onApproval(open: .preview) == .closeSheetThenShow)
        #expect(SheetPolicy.onApproval(open: .update) == .closeSheetThenShow)
        #expect(SheetPolicy.onApproval(open: .form) == .waitWithBanner)
        #expect(SheetPolicy.onApproval(open: .confirm) == .waitWithBanner)
    }
}
