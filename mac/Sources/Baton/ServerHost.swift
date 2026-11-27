import Foundation
import Observation

/// 이 맥에서 서버 관리 프로그램(server/src/supervisor.js)을 자식 프로세스로 실행한다.
/// 앱이 끝나면 서버도 끝낸다. 자동 재시작은 관리 프로그램 몫이다
@MainActor @Observable
final class ServerHost {
    private(set) var state: ServerHostState = .off
    /// 다른 맥에서 접속할 주소(서버가 로그에 찍은 LAN 줄)
    private(set) var lanURL: String?
    let port: Int
    let logURL: URL
    /// 토스트로 알릴 문구
    @ObservationIgnored var notify: (String) -> Void = { _ in }

    @ObservationIgnored private var process: Process?
    @ObservationIgnored private var parentLink: FileHandle?
    @ObservationIgnored private var health: Task<Void, Never>?
    /// stop() 이후 늦게 끝난 시작 작업을 버리는 표
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var lanCandidates: [String] = []

    init(env: [String: String] = ProcessInfo.processInfo.environment, home: URL) {
        port = ServerHostText.port(env: env)
        logURL = home.appendingPathComponent("server.log")
    }

    var logPathText: String { ToolText.shortPath(logURL.path) }
    var statusText: String { ServerHostText.statusText(state, port: port) }

    func start(node: String, source: URL, loginPath: String? = nil) {
        guard process == nil, state != .starting else { return }
        state = .starting
        lanURL = nil
        generation += 1
        let gen = generation
        Task {
            // 이미 누가 쓰는 포트면 시작하지 않는다
            let busy = await Self.responds(port: port)
            guard gen == generation else { return }
            if busy {
                state = .foreign
                notify(ServerHostText.foreignText(port: port))
            } else {
                launch(node: node, source: source, loginPath: loginPath)
            }
        }
    }

    /// 앱이 끝날 때는 wait: true — 관리 프로그램이 자식 서버를 정리하고 끝날 때까지(최대 5초) 기다린다
    func stop(wait: Bool = false) {
        generation += 1
        health?.cancel()
        health = nil
        lanURL = nil
        state = .off
        guard let p = process else { return }
        process = nil
        try? parentLink?.close()
        parentLink = nil
        kill(p.processIdentifier, SIGINT) // 관리 프로그램이 자식 서버에 SIGTERM 을 보내고 끝난다
        if wait {
            let deadline = Date().addingTimeInterval(5)
            while p.isRunning && Date() < deadline { usleep(50_000) }
            Self.forceKill(p)
        } else {
            DispatchQueue.global().asyncAfter(deadline: .now() + 5) { Self.forceKill(p) }
        }
    }

    private func launch(node: String, source: URL, loginPath: String?) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [source.appendingPathComponent("server/src/supervisor.js").path]
        p.currentDirectoryURL = source.appendingPathComponent("server")
        var env = ProcessInfo.processInfo.environment
        if let loginPath { env["PATH"] = loginPath }
        env["PORT"] = String(port)
        env["BATON_EXIT_WITH_PARENT"] = "1" // 앱이 강제 종료돼 stdin 이 끊기면 관리 프로그램도 서버를 끄고 끝난다
        p.environment = env
        let out = Pipe()
        p.standardOutput = out
        p.standardError = out
        let input = Pipe()
        p.standardInput = input
        p.terminationHandler = { [weak self] proc in
            Task { @MainActor in self?.exited(proc) }
        }
        do { try p.run() } catch {
            fail()
            return
        }
        try? out.fileHandleForWriting.close() // 자식 쪽 끝을 쥐고 있으면 EOF 가 오지 않는다
        try? input.fileHandleForReading.close()
        parentLink = input.fileHandleForWriting // 앱이 살아 있는 동안 쥐고 있는다(닫히면 관리 프로그램이 끝남)
        process = p
        lanCandidates = []
        let log = LogFile(url: logURL)
        let reader = out.fileHandleForReading
        Thread.detachNewThread { [weak self] in
            var buf = LineBuffer()
            while case let d = reader.availableData, !d.isEmpty {
                log.append(d)
                for line in buf.append(d) {
                    let text = String(decoding: line, as: UTF8.self)
                    Task { @MainActor in self?.logLine(text) }
                }
            }
        }
        health = Task { [port] in
            while !Task.isCancelled {
                let ok = await Self.responds(port: port)
                if Task.isCancelled { return }
                if ok { state = .running } else if state == .running { state = .starting }
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }

    private func logLine(_ line: String) {
        if line.hasPrefix("서버 시작:") { lanCandidates = [] } // 관리 프로그램이 서버를 다시 띄운 경우
        guard let url = ServerHostText.lanURL(inLine: line) else { return }
        lanCandidates.append(url)
        lanURL = ServerHostText.preferred(lanCandidates)
    }

    /// 관리 프로그램이 스스로 끝났다(1분에 5번 넘게 서버가 죽어 멈춘 경우 등)
    private func exited(_ p: Process) {
        guard p === process else { return }
        process = nil
        try? parentLink?.close()
        parentLink = nil
        fail()
    }

    private func fail() {
        health?.cancel()
        health = nil
        lanURL = nil
        state = .failed
        notify(ServerHostText.failedToast(logPath: logPathText))
    }

    nonisolated private static func forceKill(_ p: Process) {
        guard p.isRunning else { return }
        // 관리 프로그램만 죽이면 자식 서버가 남으므로 자식부터
        let k = Process()
        k.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
        k.arguments = ["-KILL", "-P", String(p.processIdentifier)]
        try? k.run()
        k.waitUntilExit()
        kill(p.processIdentifier, SIGKILL)
    }

    /// 127.0.0.1:포트 의 /version 이 1초 안에 200 으로 답하는지
    nonisolated static func responds(port: Int) async -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(port)/version") else { return false }
        var req = URLRequest(url: url)
        req.timeoutInterval = 1
        req.cachePolicy = .reloadIgnoringLocalCacheData
        guard let (_, resp) = try? await URLSession.shared.data(for: req) else { return false }
        return (resp as? HTTPURLResponse)?.statusCode == 200
    }
}
