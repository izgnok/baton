import Foundation

public struct CoreLaunch: Sendable {
    public var executable: URL
    public var arguments: [String]
    /// 현재 프로세스 환경 위에 덮어쓸 값.
    public var environment: [String: String]
    public var logURL: URL

    public init(executable: URL, arguments: [String] = [], environment: [String: String] = [:], logURL: URL) {
        self.executable = executable
        self.arguments = arguments
        self.environment = environment
        self.logURL = logURL
    }
}

public struct CoreEvent: Sendable {
    public let name: String
    public let payload: JSON

    public init(name: String, payload: JSON) {
        self.name = name
        self.payload = payload
    }
}

public enum CoreError: Error, Equatable {
    case remote(String), timeout, notRunning
}

/// 코어(Node) 프로세스와 줄 단위 JSON 으로 통신한다.
public final class CoreClient: @unchecked Sendable {
    private struct Pending {
        let cont: CheckedContinuation<JSON, Error>
        let timer: Task<Void, Never>?
    }

    private let launch: CoreLaunch
    private let log: LogFile
    private let lock = NSLock()  // 아래 var 전부를 보호한다
    private var process: Process?
    private var stdin: FileHandle?
    private var pending: [Int: Pending] = [:]
    private var nextID = 0
    private var running = false
    private var exitHandler: (@Sendable (Int32) -> Void)?
    private let writeQueue = DispatchQueue(label: "rooms.core.write")
    private let sink: AsyncStream<CoreEvent>.Continuation

    public let events: AsyncStream<CoreEvent>

    public var onExit: (@Sendable (Int32) -> Void)? {
        get { lock.withLock { exitHandler } }
        set { lock.withLock { exitHandler = newValue } }
    }

    public init(_ launch: CoreLaunch) {
        self.launch = launch
        self.log = LogFile(url: launch.logURL)
        (events, sink) = AsyncStream.makeStream()
    }

    public func start() throws {
        guard lock.withLock({ process == nil }) else { return }
        signal(SIGPIPE, SIG_IGN)  // 코어가 죽은 뒤 쓰기가 앱을 죽이지 않게
        let p = Process()
        p.executableURL = launch.executable
        p.arguments = launch.arguments
        p.environment = ProcessInfo.processInfo.environment.merging(launch.environment) { $1 }
        let inPipe = Pipe(), outPipe = Pipe(), errPipe = Pipe()
        p.standardInput = inPipe
        p.standardOutput = outPipe
        p.standardError = errPipe
        try p.run()
        // 자식 쪽 끝을 부모가 쥐고 있으면 EOF 가 오지 않는다.
        try? inPipe.fileHandleForReading.close()
        try? outPipe.fileHandleForWriting.close()
        try? errPipe.fileHandleForWriting.close()
        lock.withLock { process = p; stdin = inPipe.fileHandleForWriting; running = true }

        let out = outPipe.fileHandleForReading, err = errPipe.fileHandleForReading
        Thread.detachNewThread { [self] in
            var buf = LineBuffer()
            while case let d = out.availableData, !d.isEmpty {  // read(upToCount:) 는 개수를 채울 때까지 막힌다
                for line in buf.append(d) { handle(line) }
            }
            p.waitUntilExit()
            exited(p.terminationStatus)
        }
        Thread.detachNewThread { [self] in
            while case let d = err.availableData, !d.isEmpty { log.append(d) }
        }
    }

    public func call(_ name: String, _ args: JSON = .object([:]), timeout: Duration? = .seconds(120)) async throws -> JSON {
        let id = lock.withLock { nextID += 1; return nextID }
        var line = try JSONEncoder().encode(JSON.object(["id": .number(Double(id)), "call": .string(name), "args": args]))
        line.append(0x0A)
        let payload = line
        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<JSON, Error>) in
            let registered = lock.withLock { () -> Bool in
                guard running else { return false }
                let timer = timeout.map { limit in
                    Task { [weak self] in
                        do { try await Task.sleep(for: limit) } catch { return }
                        self?.finish(id, .failure(CoreError.timeout))
                    }
                }
                pending[id] = Pending(cont: cont, timer: timer)
                return true
            }
            guard registered else { return cont.resume(throwing: CoreError.notRunning) }
            writeQueue.async { [self] in
                do {
                    guard let h = lock.withLock({ stdin }) else { throw CoreError.notRunning }
                    try h.write(contentsOf: payload)
                } catch {
                    finish(id, .failure(CoreError.notRunning))
                }
            }
        }
    }

    /// stdin 을 닫아 코어가 스스로 끝나게 하고, 2초 안에 안 끝나면 강제 종료한다.
    public func stop() {
        let (p, h) = lock.withLock { () -> (Process?, FileHandle?) in
            let h = stdin
            stdin = nil
            return (process, h)
        }
        try? h?.close()
        guard let p else { return }
        DispatchQueue.global().asyncAfter(deadline: .now() + 2) { if p.isRunning { p.terminate() } }
    }

    private func finish(_ id: Int, _ result: Result<JSON, Error>) {
        guard let p = lock.withLock({ pending.removeValue(forKey: id) }) else { return }
        p.timer?.cancel()
        p.cont.resume(with: result)
    }

    private func handle(_ line: Data) {
        guard let m = try? JSONDecoder().decode(JSON.self, from: line), m["id"] != nil || m["event"] != nil else {
            log.append(Data("무시한 줄: \(String(decoding: line.prefix(200), as: UTF8.self))\n".utf8))
            return
        }
        if let id = m["id"]?.int {
            if m["ok"]?.bool == true { finish(id, .success(m["data"] ?? .null)) }
            else { finish(id, .failure(CoreError.remote(m["error"]?.string ?? "UNKNOWN"))) }
        } else if let name = m["event"]?.string {
            sink.yield(CoreEvent(name: name, payload: m["payload"] ?? .null))
        }
    }

    private func exited(_ status: Int32) {
        let (drained, h, handler) = lock.withLock { () -> ([Int: Pending], FileHandle?, (@Sendable (Int32) -> Void)?) in
            running = false
            let d = pending, h = stdin
            pending = [:]
            stdin = nil
            return (d, h, exitHandler)
        }
        try? h?.close()
        for p in drained.values {
            p.timer?.cancel()
            p.cont.resume(throwing: CoreError.notRunning)
        }
        sink.finish()
        handler?(status)
    }
}

/// stderr 를 파일에 이어 쓴다. 1MB 를 넘으면 뒤 512KB 만 남긴다.
final class LogFile: @unchecked Sendable {
    static let limit: UInt64 = 1_000_000
    static let keep = 512 * 1024
    private let url: URL
    private let lock = NSLock()

    init(url: URL) { self.url = url }

    func append(_ data: Data) {
        lock.withLock {
            let fm = FileManager.default
            try? fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            if !fm.fileExists(atPath: url.path) { fm.createFile(atPath: url.path, contents: nil) }
            guard let h = try? FileHandle(forWritingTo: url), let size = try? h.seekToEnd() else { return }
            try? h.write(contentsOf: data)
            try? h.close()
            if size + UInt64(data.count) > Self.limit, let all = try? Data(contentsOf: url) {
                try? Data(all.suffix(Self.keep)).write(to: url)
            }
        }
    }
}
