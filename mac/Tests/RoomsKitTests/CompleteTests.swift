import Testing
@testable import RoomsKit

@Suite struct CompleteTests {
    // MARK: 현재 단어 찾기

    @Test func slashOnlyAtStart() {
        #expect(Complete.detectTrigger("/", caret: 1) == .init(kind: .slash, query: "", start: 0))
        #expect(Complete.detectTrigger("/comp", caret: 5) == .init(kind: .slash, query: "comp", start: 0))
        #expect(Complete.detectTrigger("  /re", caret: 5) == .init(kind: .slash, query: "re", start: 2)) // 앞 공백은 허용
        #expect(Complete.detectTrigger("hello /comp", caret: 11) == nil) // 글 중간의 / 는 아니다
        #expect(Complete.detectTrigger("/compact now", caret: 12) == nil) // 명령 뒤 공백이 오면 끝
    }

    @Test func mentionAtWordStart() {
        #expect(Complete.detectTrigger("@ti", caret: 3) == .init(kind: .mention, query: "ti", start: 0))
        #expect(Complete.detectTrigger("이거 봐줘 @src/pa", caret: 14) == .init(kind: .mention, query: "src/pa", start: 6))
        #expect(Complete.detectTrigger("a\n@x", caret: 4) == .init(kind: .mention, query: "x", start: 2)) // 줄바꿈 뒤도 단어 시작
        #expect(Complete.detectTrigger("mail@x", caret: 6) == nil) // 단어 중간의 @ 는 아니다
        #expect(Complete.detectTrigger("@a@b", caret: 4) == nil) // @ 가 두 번이면 뒤쪽은 단어 시작이 아니다
        #expect(Complete.detectTrigger("@ti x", caret: 5) == nil) // 공백이 오면 끝
    }

    @Test func caretInTheMiddleOfAWord() {
        // 캐럿 앞까지만 본다: "@tim|eout" 은 query "tim"
        #expect(Complete.detectTrigger("@timeout", caret: 4) == .init(kind: .mention, query: "tim", start: 0))
        #expect(Complete.detectTrigger("/compact", caret: 3) == .init(kind: .slash, query: "co", start: 0))
        #expect(Complete.detectTrigger("abc @", caret: 0) == nil)
        #expect(Complete.detectTrigger("abc", caret: 99) == nil) // 범위 밖 캐럿은 끝으로
    }

    @Test func koreanNamesAndUtf16Positions() {
        #expect(Complete.detectTrigger("@하은", caret: 3) == .init(kind: .mention, query: "하은", start: 0))
        // 이모지는 UTF-16 으로 2칸: "😀 @하" 의 @ 는 3번째
        #expect(Complete.detectTrigger("😀 @하", caret: 5) == .init(kind: .mention, query: "하", start: 3))
    }

    // MARK: 후보 거르기·정렬

    @Test func rankStartsWithFirstThenContains() {
        let items = ["review", "pre-review", "commit", "x"]
        let r = Complete.rankByQuery(items, query: "REV", name: { $0 })
        #expect(r == ["review", "pre-review"])
        #expect(Complete.rankByQuery(items, query: "", name: { $0 }) == items)
        #expect(Complete.rankByQuery(items, query: "zzz", name: { $0 }).isEmpty) // 후보 없음
    }

    @Test func rankMatchesDescription() {
        let skills = [Complete.Skill(name: "review", description: "변경한 코드를 검토해요", source: "user"),
                      Complete.Skill(name: "docs", description: "문서를 정리해요", source: "user")]
        let r = Complete.rankByQuery(skills, query: "검토", name: \.name, desc: \.description)
        #expect(r.map(\.name) == ["review"])
    }

    @Test func slashSuggestionsIncludeCompactFirst() {
        let skills = [Complete.Skill(name: "review", description: "변경한 코드를 검토해요", source: "plugin")]
        let all = Complete.slashSuggestions(skills: skills, query: "")
        #expect(all.map(\.insert) == ["/compact", "/review"])
        #expect(all[0].desc == "대화를 줄여요")
        #expect(all[1].source == "plugin")
        #expect(Complete.slashSuggestions(skills: skills, query: "rev").map(\.name) == ["/review"])
        #expect(Complete.slashSuggestions(skills: skills, query: "q").isEmpty)
    }

    @Test func memberAndSharedSuggestions() {
        let m = Complete.memberSuggestions(names: ["하은", "지환"], query: "하")
        #expect(m == [.init(insert: "@하은", name: "하은", source: "member")])
        let s = Complete.sharedSuggestions(paths: ["outputs/정리.md", "memory/INDEX.md"], query: "정리")
        #expect(s == [.init(insert: "@shared/outputs/정리.md", name: "shared/outputs/정리.md", source: "shared")])
        #expect(Complete.repoSuggestion(name: "payment-api", path: "src/payment/timeout.js", mention: "payment-api/src/payment/timeout.js")
            == .init(insert: "@payment-api/src/payment/timeout.js", name: "src/payment/timeout.js", desc: "payment-api", source: "repo"))
    }

    @Test func mergeMentionLimits() {
        let members = ["m1", "m2", "m3", "m4"]
        let shared = ["s1", "s2", "s3", "s4"]
        let repo = (1...10).map { "r\($0)" }
        let r = Complete.mergeMentionItems(members: members, shared: shared, repoFiles: repo)
        #expect(r == ["m1", "m2", "m3", "s1", "s2", "s3", "r1", "r2"]) // 멤버 3 + 공유 3 + 나머지 레포, 합쳐서 8
        #expect(Complete.mergeMentionItems(members: ["m1"], shared: [], repoFiles: repo, max: 4) == ["m1", "r1", "r2", "r3"])
        #expect(Complete.mergeMentionItems(members: members, shared: shared, repoFiles: repo, max: 2) == ["m1", "m2"])
    }

    // MARK: 치환·캐럿

    @Test func applyAddsSpaceAndPlacesCaretAfterIt() {
        let t = Complete.detectTrigger("@ti", caret: 3)!
        let e = Complete.applyChoice("@ti", caret: 3, trigger: t, insert: "@src/timeout.js")
        #expect(e.value == "@src/timeout.js ")
        #expect(e.caret == 16)
    }

    @Test func applyKeepsExistingSpaceAfterCaret() {
        let t = Complete.detectTrigger("보고 @ti 해줘", caret: 6)!
        let e = Complete.applyChoice("보고 @ti 해줘", caret: 6, trigger: t, insert: "@하은")
        #expect(e.value == "보고 @하은 해줘") // 뒤가 이미 공백이면 하나 더 붙이지 않는다
        #expect(e.caret == 3 + 3 + 1) // 공백 뒤
    }

    @Test func applyInTheMiddleOfAWordKeepsTail() {
        // "@tim|eout" 에서 고르면 caret 뒤 글자는 그대로 이어 붙는다(JS 와 같음)
        let t = Complete.detectTrigger("@timeout", caret: 4)!
        let e = Complete.applyChoice("@timeout", caret: 4, trigger: t, insert: "@하은")
        #expect(e.value == "@하은 eout")
        #expect(e.caret == 4)
    }

    @Test func applySlashReplacesOnlyTheCommand() {
        let t = Complete.detectTrigger("/co", caret: 3)!
        let e = Complete.applyChoice("/co", caret: 3, trigger: t, insert: "/compact")
        #expect(e.value == "/compact ")
        #expect(e.caret == 9)
    }

    // MARK: 보내는 글

    @Test func claudeStartRule() {
        #expect(Complete.startsWithClaude("/compact"))
        #expect(Complete.startsWithClaude("  /compact"))
        #expect(Complete.startsWithClaude("@claude 이거 해줘"))
        #expect(Complete.startsWithClaude("@Claude"))
        #expect(!Complete.startsWithClaude("@claudette 안녕"))
        #expect(!Complete.startsWithClaude("안녕 @claude"))
        #expect(!Complete.startsWithClaude("   "))
    }

    @Test func outgoingText() {
        #expect(Complete.outgoing("정리해줘", toClaude: true) == "@claude 정리해줘")
        #expect(Complete.outgoing("/compact", toClaude: true) == "/compact") // / 는 대상과 무관하게 Claude
        #expect(Complete.outgoing("@claude 안녕", toClaude: true) == "@claude 안녕")
        #expect(Complete.outgoing("점심 먹을래요", toClaude: false) == "점심 먹을래요") // [사람] 은 그대로
    }
}
