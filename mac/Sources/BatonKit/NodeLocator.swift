import Foundation

public enum NodeLocator {
    static let fixedPaths = ["/opt/homebrew/bin/node", "/usr/local/bin/node"]

    public static func find(shell: String?, run: (String, [String]) -> String?, exists: (String) -> Bool) -> String? {
        if let shell, let out = run(shell, ["-ilc", "command -v node"]),
           let line = lastLine(out), line.hasPrefix("/"), exists(line) {
            return line
        }
        return fixedPaths.first(where: exists)
    }

    public static func loginPath(shell: String?, run: (String, [String]) -> String?) -> String? {
        guard let shell, let out = run(shell, ["-ilc", "printf %s \"$PATH\""]) else { return nil }
        return lastLine(out)
    }

    public static func findNode() -> String? {
        find(shell: ProcessInfo.processInfo.environment["SHELL"], run: runProcess, exists: FileManager.default.isExecutableFile(atPath:))
    }

    public static func loginPATH() -> String? {
        loginPath(shell: ProcessInfo.processInfo.environment["SHELL"], run: runProcess)
    }

    // 로그인 셸 메시지가 앞에 섞여도 마지막 줄만 쓴다.
    private static func lastLine(_ s: String) -> String? {
        s.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .last(where: { !$0.isEmpty })
    }

    private final class Box: @unchecked Sendable { var data = Data() }

    /// 실행 파일을 5초 제한으로 돌려 stdout 을 문자열로 돌려준다. 실패·시간 초과·비정상 종료는 nil.
    static func runProcess(_ exe: String, _ args: [String]) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: exe)
        p.arguments = args
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        p.standardInput = FileHandle.nullDevice
        do { try p.run() } catch { return nil }
        try? out.fileHandleForWriting.close()
        let box = Box()
        let done = DispatchSemaphore(value: 0)
        Thread.detachNewThread {
            box.data = (try? out.fileHandleForReading.readToEnd()) ?? Data()
            done.signal()
        }
        if done.wait(timeout: .now() + 5) == .timedOut {
            p.terminate()
            return nil
        }
        p.waitUntilExit()
        return p.terminationStatus == 0 ? String(decoding: box.data, as: UTF8.self) : nil
    }
}
