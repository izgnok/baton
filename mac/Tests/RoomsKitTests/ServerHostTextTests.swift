import Testing
@testable import RoomsKit

@Suite struct ServerHostTextTests {
    @Test func portDefaultsTo4310() {
        #expect(ServerHostText.port(env: [:]) == 4310)
        #expect(ServerHostText.port(env: ["ROOMS_SERVER_PORT": "4399"]) == 4399)
        #expect(ServerHostText.port(env: ["ROOMS_SERVER_PORT": "abc"]) == 4310)
        #expect(ServerHostText.port(env: ["ROOMS_SERVER_PORT": "70000"]) == 4310)
    }

    @Test func lanLineParsed() {
        #expect(ServerHostText.lanURL(inLine: "  LAN: http://192.0.2.7:4310") == "http://192.0.2.7:4310")
        #expect(ServerHostText.lanURL(inLine: "서버 시작: http://localhost:4310 (데이터 /x)") == nil)
        #expect(ServerHostText.lanURL(inLine: "LAN: http://") == nil)
    }

    @Test func privateAddressPreferred() {
        let urls = ["http://100.64.1.2:4310", "http://172.20.0.3:4310", "http://10.1.1.1:4310"]
        #expect(ServerHostText.preferred(urls) == "http://172.20.0.3:4310")
        #expect(ServerHostText.preferred(["http://100.64.1.2:4310"]) == "http://100.64.1.2:4310")
        #expect(ServerHostText.preferred([]) == nil)
        #expect(ServerHostText.isPrivate("http://172.32.0.1:4310") == false)
    }

    @Test func texts() {
        #expect(ServerHostText.foreignText(port: 4399) == "이미 4399에서 서버가 돌고 있어요")
        #expect(ServerHostText.statusText(.off, port: 4310) == "꺼져 있어요")
        #expect(ServerHostText.statusText(.foreign, port: 4310) == "이미 4310에서 서버가 돌고 있어요")
        #expect(ServerHostText.failedToast(logPath: "~/.claude-rooms/server.log").hasSuffix("server.log에 있어요"))
    }
}
