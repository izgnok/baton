import Foundation
import Testing
@testable import RoomsKit

@Suite struct FormatTests {
    // 2026-11-26 은 목요일
    private func at(_ d: Int, _ h: Int, _ m: Int) -> Double {
        Calendar.current.date(from: DateComponents(year: 2026, month: 11, day: d, hour: h, minute: m))!.timeIntervalSince1970 * 1000
    }

    @Test func failAndErrorText() {
        #expect(Format.failText("PREFLIGHT:BRANCH_MISMATCH") == "레포 브랜치가 방 설정과 달라요")
        // 바뀐 기대값: 조사 붙여 쓰기("Claude 가" → "Claude가")
        #expect(Format.failText("CLAUDE_EXIT_2") == "Claude가 비정상 종료했어요(2)")
        #expect(Format.failText("WHAT") == "실행에 실패했어요(WHAT)")
        #expect(Format.failText(nil) == "실행에 실패했어요(알 수 없음)")
        #expect(Format.failText("CLAUDE_NOT_FOUND") == "이 컴퓨터에서 claude를 찾지 못했어요")
        #expect(Format.errorText("EMAIL_TAKEN") == "이미 가입한 이메일이에요")
        #expect(Format.errorText("UPDATE_BUSY") == "Claude가 실행 중이에요. 끝난 뒤 다시 눌러 주세요")
        #expect(Format.errorText("WHAT") == "문제가 생겼어요(WHAT)")
        #expect(Format.formatDate(0).wholeMatch(of: /\d{4}\.\d{2}\.\d{2}/) != nil)
    }

    @Test func personAndInitial() {
        for id in [1, 2, 7, 100] { #expect((0...5).contains(Format.personIndex(id))) }
        #expect(Format.personIndex(3) == Format.personIndex("3"))
        #expect(Format.personIndex(1) != Format.personIndex(2))
        #expect(Format.initial("  하은") == "하")
        #expect(Format.initial("abc") == "A")
        #expect(Format.initial("") == "?")
    }

    @Test func usageText() {
        let now = at(26, 10, 0)
        #expect(Format.usageLabel(.fiveHour, .init(utilization: 0.21, resetsAt: at(26, 15, 0)), now: now) == "5시간 21% · 15:00 초기화")
        // 바뀐 기대값: 요일을 "금" → "금요일"
        #expect(Format.usageLabel(.sevenDay, .init(utilization: 0.567, resetsAt: at(27, 14, 0)), now: now) == "주간 57% · 금요일 14:00 초기화")
        #expect(Format.usageLabel(.fiveHour, .init(utilization: 0.5, resetsAt: at(26, 9, 0)), now: now) == "5시간 50% · 초기화 시각이 지났어요")
        #expect(Format.usageWarn(.init(utilization: 0.8, resetsAt: 0)))
        #expect(!Format.usageWarn(.init(utilization: 0.79, resetsAt: 0)))
        #expect(Format.usageChecked(at(26, 9, 5), now: now) == "마지막 확인 09:05")
        #expect(Format.usageChecked(at(25, 9, 5), now: now) == "마지막 확인 11.25 09:05")
    }

    @Test func roomCreated() {
        #expect(Format.createdText(at(27, 9, 0)) == "11월 27일에 만들었어요")
    }

    @Test func memberSummaryAndLabels() {
        // 바뀐 기대값: 4장 형식(이름표 줄, "읽는 폴더", "Claude 로그인됨/안 됨")
        #expect(Format.memberSummary(.init(repos: ["a", "b"], readDirs: ["x"], claude: true)) == "레포 a, b / 읽는 폴더 x / Claude 로그인됨")
        #expect(Format.memberSummary(.init(repos: [], readDirs: [], claude: false)) == "레포 없음 / 읽는 폴더 없음 / Claude 로그인 안 됨")
        #expect(Format.memberSummaryLines(.init(repos: ["a"], readDirs: [], claude: true)) == ["레포 a", "읽는 폴더 없음", "Claude 로그인됨"])
        #expect(Format.memberSummary(nil) == "아직 연결 정보가 없어요")
        #expect([Format.modelLabel("opus"), Format.modelLabel("claude-x-1"), Format.modelLabel("")] == ["Opus(최신)", "claude-x-1", ""])
        #expect([Format.modelLabel("claude-opus-5-5"), Format.modelLabel("claude-fable-5-2"), Format.modelLabel("claude-haiku-5-5-20261101")]
            == ["Opus 5.5", "Fable 5.2", "Haiku 5.5"])
        #expect([Format.effortLabel("xhigh"), Format.effortLabel("")] == ["매우 높음", ""])
        #expect(Format.statusText["cancelled"] == "중단됨")
        #expect(Format.errorText("NOT_CANCELLABLE") == "이미 끝났거나 중단할 수 없는 요청이에요")
    }

    @Test func contextLabelAndTokens() {
        #expect(Format.tokenCount(9500) == "9,500")
        #expect(Format.tokenCount(144_855) == "14.5만")
        #expect(Format.tokenCount(1_000_000) == "100만")
        #expect(Format.tokenCount(30_000) == "3만")
        #expect(Format.contextLabel(tokens: 144_855, model: "claude-opus-5-5") == "컨텍스트 14% · 14.5만/100만")
        #expect(Format.contextLabel(tokens: 900, model: "claude-sonnet-5-5") == "컨텍스트 1% · 900/100만")
        #expect(Format.contextLabel(tokens: 0, model: nil) == "컨텍스트 0% · 0/100만")
        #expect(Format.contextWindow("claude-haiku-4-5") == 200_000)
    }
}
