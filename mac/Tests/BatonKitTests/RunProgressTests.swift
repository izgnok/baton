import Foundation
import Testing
@testable import BatonKit

@Suite struct RunProgressTests {
    private func ev(_ n: Int, _ kind: RunEvent.Kind, at: Double = 0, parent: String? = nil) -> RunEvent {
        RunEvent(key: "\(n):0", parent: parent, at: at, kind: kind)
    }
    private func use(_ id: String, _ name: String, _ input: [String: JSON] = [:]) -> RunEvent.Kind {
        .toolUse(id: id, name: name, input: .object(input))
    }
    private func result(_ id: String, async: Bool = false) -> RunEvent.Kind { .toolResult(toolUseId: id, asyncLaunch: async) }

    @Test func thinkingWhenNothingPending() {
        #expect(RunProgress.step([]) == .thinking)
        #expect(RunProgress.step([ev(1, .thinking)]).label == "생각하는 중…")
        // 결과가 온 뒤 다음 단계도 생각 중
        #expect(RunProgress.step([ev(1, use("a", "Bash")), ev(2, result("a"))]) == .thinking)
    }

    @Test func runningToolShowsLabelAndDetail() {
        let s = RunProgress.step([ev(1, use("a", "Bash", ["command": .string("grep -rn x src")]))])
        #expect(s.label == "명령 실행 중")
        #expect(s.detail == "grep -rn x src")
        let read = RunProgress.step([ev(1, use("a", "Read", ["file_path": .string("/a/b.js")]))])
        #expect(read.label == "파일 읽는 중")
        #expect(RunProgress.step([ev(1, use("a", "mcp__x__y"))]).label == "mcp__x__y 실행 중")
    }

    @Test func lastUnfinishedToolWins() {
        let events = [ev(1, use("a", "Read")), ev(2, use("b", "Grep", ["pattern": .string("foo")])), ev(3, result("a"))]
        #expect(RunProgress.step(events) == .tool(name: "Grep", detail: "foo"))
    }

    @Test func subagentsCountOnlyUnfinished() {
        let two = [ev(1, use("a1", "Agent")), ev(2, use("a2", "Task")), ev(3, result("a1", async: true)), ev(4, result("a2", async: true))]
        #expect(RunProgress.step(two) == .subagents(2))
        #expect(RunProgress.step(two).label == "서브에이전트 2개 작업 중")
        // 하나는 일반 결과로 끝남, 하나는 백그라운드라 task_notification 이 와야 끝
        let one = [ev(1, use("a1", "Agent")), ev(2, use("a2", "Agent")), ev(3, result("a1")), ev(4, result("a2", async: true))]
        #expect(RunProgress.step(one) == .subagents(1))
        let notified = one + [ev(5, .taskDone(toolUseId: "a2"))]
        #expect(RunProgress.step(notified) == .thinking)
    }

    @Test func subagentInnerToolsDoNotShadowSubagentLine() {
        let events = [ev(1, use("a1", "Agent")), ev(2, use("c1", "Grep"), parent: "a1")]
        #expect(RunProgress.step(events) == .subagents(1))
        // 최상위 도구가 돌고 있으면 그것을 보여 준다
        #expect(RunProgress.step(events + [ev(3, use("b", "Bash"))]).label == "명령 실행 중")
    }

    @Test func elapsedFormat() {
        #expect(RunProgress.elapsedText(0) == "0초")
        #expect(RunProgress.elapsedText(59) == "59초")
        #expect(RunProgress.elapsedText(60) == "1분")
        #expect(RunProgress.elapsedText(125) == "2분 5초")
        #expect(RunProgress.elapsedText(-3) == "0초")
    }

    @Test func thinkingSecondsFromPreviousEventInSameScope() {
        let events = [
            ev(1, .text, at: 1000),
            ev(2, .thinking, at: 9000),                       // 앞 이벤트 8초 뒤
            ev(3, .thinking, at: 9400),                       // 0.4초 → 빠짐
            ev(4, use("a", "Agent"), at: 9500),
            ev(5, .thinking, at: 20000, parent: "a"),         // 서브에이전트 안 첫 이벤트 → 빠짐
            ev(6, .thinking, at: 26000, parent: "a"),         // 같은 서브에이전트의 앞 이벤트 6초 뒤
        ]
        let s = RunProgress.thinkingSeconds(events)
        #expect(s["2:0"] == 8)
        #expect(s["3:0"] == nil)
        #expect(s["5:0"] == nil)
        #expect(s["6:0"] == 6)
        #expect(RunProgress.thinkingSeconds([ev(1, .thinking, at: 5000)]).isEmpty)
    }

    @Test func groupsChildrenUnderParentKeepingOrder() {
        struct Item: Equatable { var n: Int; var parent: String? }
        let items = [Item(n: 1, parent: nil), Item(n: 2, parent: "a"), Item(n: 3, parent: "b"), Item(n: 4, parent: "a"),
                     Item(n: 5, parent: "ghost"), Item(n: 6, parent: nil), Item(n: 7, parent: "b")]
        let g = RunProgress.groupByParent(items, parent: { $0.parent }, parents: ["a", "b"])
        #expect(g.top.map(\.n) == [1, 5, 6])          // 부모를 모르는 고아(5)는 최상위
        #expect(g.children["a"]?.map(\.n) == [2, 4])
        #expect(g.children["b"]?.map(\.n) == [3, 7])
        #expect(g.children["ghost"] == nil)
    }

    @Test func agentTitleFallsBackToType() {
        #expect(RunProgress.agentTitle(.object(["description": .string("로그 찾기"), "subagent_type": .string("Explore")])) == "로그 찾기")
        #expect(RunProgress.agentTitle(.object(["description": .string(""), "subagent_type": .string("Explore")])) == "Explore")
        #expect(RunProgress.agentTitle(nil) == "")
    }

    @Test func parsesRealEventShapes() throws {
        func parse(_ s: String, id: Int = 7, at: Double = 100) throws -> [RunEvent] {
            RunEvent.parse(try JSONDecoder().decode(JSON.self, from: Data(s.utf8)), id: id, at: at)
        }
        let think = try parse(#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"","signature":"x"}]}}"#)
        #expect(think == [RunEvent(key: "7:0", parent: nil, at: 100, kind: .thinking)])
        let tool = try parse(#"{"type":"assistant","parent_tool_use_id":"toolu_1","message":{"content":[{"type":"text","text":"a"},{"type":"tool_use","id":"t2","name":"Grep","input":{"pattern":"x"}}]}}"#)
        #expect(tool.map(\.key) == ["7:0", "7:1"])
        #expect(tool.allSatisfy { $0.parent == "toolu_1" })
        #expect(tool[1].kind == .toolUse(id: "t2", name: "Grep", input: .object(["pattern": .string("x")])))
        let asyncRes = try parse(#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"Async agent launched successfully."}]}]}}"#)
        #expect(asyncRes.map(\.kind) == [.toolResult(toolUseId: "t1", asyncLaunch: true)])
        let plain = try parse(#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"done"}]}}"#)
        #expect(plain.map(\.kind) == [.toolResult(toolUseId: "t1", asyncLaunch: false)])
        let done = try parse(#"{"type":"system","subtype":"task_notification","tool_use_id":"t1","status":"completed"}"#)
        #expect(done.map(\.kind) == [.taskDone(toolUseId: "t1")])
        #expect(try parse(#"{"type":"system","subtype":"init"}"#).isEmpty)
    }
}
