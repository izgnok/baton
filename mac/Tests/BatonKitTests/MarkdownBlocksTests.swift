import Foundation
import Testing
@testable import BatonKit

@Suite struct MarkdownBlocksTests {
    private func plain(_ a: AttributedString) -> String { String(a.characters) }

    /// 블록을 한 줄 글자로 줄여 비교한다
    private func brief(_ b: MarkdownBlock) -> String {
        switch b {
        case .heading(let l, let a): "h\(l):\(plain(a))"
        case .paragraph(let a): "p:\(plain(a))"
        case .listItem(let o, let i, let d, let a): "\(o ? "ol" : "ul")\(i)@\(d):\(plain(a))"
        case .quote(let a): "q:\(plain(a))"
        case .code(let l, let t): "code[\(l ?? "")]:\(t)"
        case .table(let h, let r): "table:\(h.map(plain))|\(r.map { $0.map(plain) })"
        case .rule: "rule"
        }
    }

    @Test func headings() {
        let b = markdownBlocks("# 하나\n## 둘\n### 셋\n\n본문")
        #expect(b.map(brief) == ["h1:하나", "h2:둘", "h3:셋", "p:본문"])
    }

    @Test func listsOrderedUnorderedNested() {
        let b = markdownBlocks("1. 첫째\n2. 둘째\n   - 중첩 a\n   - 중첩 b\n\n- 점 하나")
        #expect(b.map(brief) == ["ol1@0:첫째", "ol2@0:둘째", "ul1@1:중첩 a", "ul2@1:중첩 b", "ul1@0:점 하나"])
    }

    @Test func codeBlockWithLanguage() {
        let b = markdownBlocks("앞\n\n```js\nconst a = 1;\nlet b;\n```\n\n```\n없음\n```")
        #expect(b.map(brief) == ["p:앞", "code[js]:const a = 1;\nlet b;", "code[]:없음"])
    }

    @Test func table() {
        let b = markdownBlocks("| 위치 | 내용 |\n|---|---|\n| a | |\n| `b` | 값 |\n\n끝")
        #expect(b.map(brief) == ["table:[\"위치\", \"내용\"]|[[\"a\", \"\"], [\"b\", \"값\"]]", "p:끝"])
    }

    @Test func quote() {
        let b = markdownBlocks("> 인용문\n\n본문")
        #expect(b.map(brief) == ["q:인용문", "p:본문"])
    }

    @Test func rawHTMLStaysAsText() {
        let b = markdownBlocks("앞 <b>태그</b> <script>alert(1)</script> 뒤\n\n<div>블록</div>\n<script>alert(2)</script>")
        #expect(b.count == 2)
        #expect(plain(paragraphText(b[0])) == "앞 <b>태그</b> <script>alert(1)</script> 뒤")
        #expect(brief(b[1]) == "code[html]:<div>블록</div>\n<script>alert(2)</script>")
    }

    @Test func onlyHttpLinksStayLinks() {
        let b = markdownBlocks("[좋음](https://example.com) [나쁨](javascript:alert(1)) [파일](file:///etc/passwd) [상대](a/b.md)")
        guard case .paragraph(let a) = b[0] else { Issue.record("문단이 아니에요"); return }
        let links = a.runs.compactMap { r in r.link.map { (plain(AttributedString(a[r.range])), $0.absoluteString) } }
        #expect(links.count == 1)
        #expect(links.first?.0 == "좋음")
        #expect(links.first?.1 == "https://example.com")
        #expect(plain(a) == "좋음 나쁨 파일 상대") // 링크가 아니어도 글자는 남는다
    }

    @Test func imageBecomesAltText() {
        let b = markdownBlocks("![그림 설명](http://example.com/a.png)")
        guard case .paragraph(let a) = b[0] else { Issue.record("문단이 아니에요"); return }
        #expect(plain(a) == "그림 설명")
        #expect(a.runs.allSatisfy { $0.imageURL == nil })
    }

    @Test func boldAndCodeInOneParagraph() {
        let b = markdownBlocks("문단 **굵게** 와 `코드` 끝\n줄바꿈")
        guard case .paragraph(let a) = b[0] else { Issue.record("문단이 아니에요"); return }
        #expect(plain(a) == "문단 굵게 와 코드 끝\n줄바꿈")
        let bold = a.runs.filter { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true }.map { plain(AttributedString(a[$0.range])) }
        let code = a.runs.filter { $0.inlinePresentationIntent?.contains(.code) == true }.map { plain(AttributedString(a[$0.range])) }
        #expect(bold == ["굵게"])
        #expect(code == ["코드"])
    }

    private func paragraphText(_ b: MarkdownBlock) -> AttributedString {
        if case .paragraph(let a) = b { return a }
        Issue.record("문단이 아니에요")
        return AttributedString()
    }
}
