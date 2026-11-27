import SwiftUI

/// 5시간·주간 사용량 막대 + 마지막 확인 시각
struct UsageBars: View {
    let usage: UsageState?

    var body: some View {
        let rows: [(UsageKind, UsageWindow)] = [(.fiveHour, usage?.fiveHour), (.sevenDay, usage?.sevenDay)].compactMap { k, w in w.map { (k, $0) } }
        if rows.isEmpty {
            Text("사용량을 아직 읽지 못했어요").typo(.caption).foregroundStyle(Theme.sub)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(rows, id: \.0) { kind, w in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(Format.usageLabel(kind, w)).typo(.caption).foregroundStyle(Theme.text).lineLimit(1)
                        Bar(fraction: w.utilization, warn: Format.usageWarn(w))
                    }
                }
                if let at = usage?.updatedAt {
                    Text(Format.usageChecked(at)).typo(.caption).foregroundStyle(Theme.sub)
                }
            }
            .frame(width: 260, alignment: .leading)
        }
    }

    private struct Bar: View {
        let fraction: Double
        let warn: Bool

        var body: some View {
            GeometryReader { g in
                ZStack(alignment: .leading) {
                    Capsule().fill(Theme.usageTrack)
                    Capsule().fill(warn ? Theme.warn : Theme.accent)
                        .frame(width: g.size.width * min(1, max(0, fraction)))
                }
            }
            .frame(height: 6)
        }
    }
}
