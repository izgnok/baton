import Foundation

/// 이 맥에서 서버를 실행하는 기능의 상태 판정과 문구
public enum ServerHostState: Equatable, Sendable {
    case off, starting, running, foreign, failed
}

public enum ServerHostText {
    public static let defaultPort = 4310

    /// 환경 변수 BATON_SERVER_PORT(테스트·실험용)가 올바른 포트면 그 값, 아니면 4310
    public static func port(env: [String: String]) -> Int {
        guard let v = env["BATON_SERVER_PORT"], let n = Int(v), (1...65535).contains(n) else { return defaultPort }
        return n
    }

    /// 서버가 시작할 때 찍는 `  LAN: http://주소:포트` 한 줄에서 주소를 꺼낸다
    public static func lanURL(inLine line: String) -> String? {
        let t = line.trimmingCharacters(in: .whitespaces)
        guard t.hasPrefix("LAN: http://") else { return nil }
        let url = String(t.dropFirst("LAN: ".count))
        return URL(string: url)?.host == nil ? nil : url
    }

    /// 여러 주소 중 사설 대역(10.·172.16~31.·192.168.)을 먼저, 없으면 첫 주소
    public static func preferred(_ urls: [String]) -> String? {
        urls.first(where: isPrivate) ?? urls.first
    }

    static func isPrivate(_ url: String) -> Bool {
        guard let host = URL(string: url)?.host else { return false }
        let p = host.split(separator: ".").compactMap { Int($0) }
        guard p.count == 4 else { return false }
        return p[0] == 10 || (p[0] == 172 && (16...31).contains(p[1])) || (p[0] == 192 && p[1] == 168)
    }

    public static func foreignText(port: Int) -> String { "이미 \(port)에서 서버가 돌고 있어요" }

    public static func statusText(_ state: ServerHostState, port: Int) -> String {
        switch state {
        case .off: "꺼져 있어요"
        case .starting: "서버를 켜는 중이에요"
        case .running: "서버가 실행 중이에요"
        case .foreign: foreignText(port: port)
        case .failed: "서버가 멈췄어요. 로그를 확인해 주세요"
        }
    }

    /// 실패 토스트. 로그 위치를 알린다
    public static func failedToast(logPath: String) -> String { "서버가 멈췄어요. 로그는 \(logPath)에 있어요" }
}
