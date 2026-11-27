import Foundation

public struct RestartPolicy {
    private let max: Int
    private let window: TimeInterval
    private var times: [Date] = []

    public init(max: Int = 3, window: TimeInterval = 60) {
        self.max = max
        self.window = window
    }

    /// 창 안에서 max 번까지 true. 넘으면 false(그 시도는 기록하지 않는다).
    public mutating func shouldRestart(at now: Date) -> Bool {
        times.removeAll { now.timeIntervalSince($0) >= window }
        guard times.count < max else { return false }
        times.append(now)
        return true
    }
}
