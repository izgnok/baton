import Foundation
import Testing
@testable import BatonKit

private final class StatusBox: @unchecked Sendable { var value: Int32 = -1 }

// 가짜 코어(Fixtures/fake-core.mjs)를 node 로 띄워 본다. node 가 없으면 건너뛴다.
@Suite(.enabled(if: NodeLocator.findNode() != nil, "node 를 찾지 못함"))
struct CoreClientTests {
    private static let fake = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/fake-core.mjs")

    private func withClient(_ body: (CoreClient, URL) async throws -> Void) async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("rooms-test-\(UUID().uuidString)")
        let logURL = dir.appendingPathComponent("core.log")
        let client = CoreClient(CoreLaunch(executable: URL(fileURLWithPath: NodeLocator.findNode()!), arguments: [Self.fake.path], logURL: logURL))
        try client.start()
        defer { client.stop(); try? FileManager.default.removeItem(at: dir) }
        try await body(client, logURL)
    }

    @Test func callReturnsData() async throws {
        try await withClient { client, _ in
            let r = try await client.call("echo", .object(["a": .string("한글"), "n": .number(2), "b": .bool(true)]))
            #expect(r["a"]?.string == "한글")
            #expect(r["n"]?.int == 2)
            #expect(r["b"]?.bool == true)
        }
    }

    @Test func remoteError() async throws {
        try await withClient { client, _ in
            await #expect(throws: CoreError.remote("NOT_FOUND")) { try await client.call("fail") }
            await #expect(throws: CoreError.remote("UNKNOWN_CALL")) { try await client.call("nope") }
        }
    }

    @Test func eventStream() async throws {
        try await withClient { client, _ in
            _ = try await client.call("emit", .object(["event": .string("usage"), "payload": .object(["x": .number(1)])]))
            var it = client.events.makeAsyncIterator()
            let e = await it.next()
            #expect(e?.name == "usage")
            #expect(e?.payload["x"]?.int == 1)
        }
    }

    @Test func timeout() async throws {
        try await withClient { client, _ in
            await #expect(throws: CoreError.timeout) {
                try await client.call("sleep", .object(["ms": .number(1000)]), timeout: .milliseconds(150))
            }
            // 시간 초과 뒤에도 다음 호출은 정상
            let r = try await client.call("echo", .object(["ok": .bool(true)]))
            #expect(r["ok"]?.bool == true)
        }
    }

    @Test func exitCallback() async throws {
        try await withClient { client, _ in
            let status = StatusBox()
            client.onExit = { status.value = $0 }
            await #expect(throws: CoreError.notRunning) { try await client.call("exit") }
            for _ in 0..<100 where status.value == -1 { try await Task.sleep(for: .milliseconds(50)) }
            #expect(status.value == 3)
            await #expect(throws: CoreError.notRunning) { try await client.call("echo") }
            var it = client.events.makeAsyncIterator()
            #expect(await it.next() == nil)  // 스트림 종료
        }
    }

    @Test func largeKoreanResponse() async throws {
        try await withClient { client, _ in
            let big = String(repeating: "가나다라마바사", count: 30_000)  // 약 630KB UTF-8
            let r = try await client.call("echo", .object(["s": .string(big)]))
            #expect(r["s"]?.string == big)
        }
    }

    @Test func logKeepsTail() async throws {
        try await withClient { client, logURL in
            _ = try await client.call("spam")
            let size: () -> UInt64 = { (try? FileManager.default.attributesOfItem(atPath: logURL.path)[.size] as? UInt64) ?? 0 }
            for _ in 0..<60 where size() == 0 { try await Task.sleep(for: .milliseconds(50)) }
            try await Task.sleep(for: .milliseconds(500))
            #expect(size() > 0)
            #expect(size() <= LogFile.limit)
        }
    }
}
