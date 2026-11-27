import Testing
@testable import BatonKit

@Suite struct ToolTextTests {
    @Test func labelsAndFallback() {
        #expect(ToolText.label("Bash") == "명령 실행")
        #expect(ToolText.label("Edit") == "파일 고치기")
        #expect(ToolText.label("Grep") == "내용 찾기")
        #expect(ToolText.label("MyTool") == "MyTool")
        #expect(ToolText.label(nil) == "도구")
    }

    @Test func summaryUsesOneLineDetail() {
        let read = ToolText.summary(name: "Read", input: .object(["file_path": .string("/Users/me/a/b.js")]))
        #expect(read.label == "파일 읽기")
        #expect(read.detail == "/Users/me/a/b.js")
        let bash = ToolText.summary(name: "Bash", input: .object(["command": .string("grep -rn x src |\n head")]))
        #expect(bash.detail == "grep -rn x src | head")
        #expect(ToolText.summary(name: "Foo", input: nil).detail == "")
    }

    @Test func homeBecomesTilde() {
        #expect(ToolText.shortPath("/Users/me/x/y.md", home: "/Users/me") == "~/x/y.md")
        #expect(ToolText.shortPath("/Users/meow/y.md", home: "/Users/me") == "/Users/meow/y.md")
    }
}
