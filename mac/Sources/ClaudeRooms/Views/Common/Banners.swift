import SwiftUI

/// 화면 맨 위 띠: 연결 끊김, 새 버전, 서버 버전 다름
struct Banners: View {
    let app: AppModel
    @Local private var showDetail = false
    @Local private var updating = false

    var body: some View {
        VStack(spacing: 0) {
            if app.coreDown {
                bar(fill: Theme.warn) {
                    Text(app.coreMessage ?? "연결이 끊겼어요 · 로그 \(AppModel.logPath)").foregroundStyle(Theme.bannerWarnText)
                }
            } else if !app.connected {
                bar(fill: Theme.warn) {
                    Text("서버와 연결이 끊겼어요. 다시 연결하는 중…").foregroundStyle(Theme.bannerWarnText)
                }
            }
            if app.update.count > 0 || app.update.serverMismatch {
                // 둘 다 있으면 한 줄에 이어 붙인다(점검표 UB3)
                bar(fill: app.update.serverMismatch ? Theme.warnSoft : Theme.accentSoft) {
                    if app.update.count > 0 { updateSegment }
                    if app.update.count > 0 && app.update.serverMismatch { Text("·").foregroundStyle(Theme.sub) }
                    if app.update.serverMismatch {
                        Text("서버 버전이 달라요 — 서버를 다시 켜 주세요").foregroundStyle(Theme.warnText)
                    }
                }
            }
        }
        .sheet(isPresented: $showDetail) { UpdateDetailSheet(update: app.update) }
    }

    private var updateSegment: some View {
        HStack(spacing: 8) {
            Text("새 버전이 있어요 (커밋 \(app.update.count)개)").foregroundStyle(Theme.text)
            Button("자세히") { showDetail = true }.buttonStyle(.rooms(.plain, .small))
            Button(updating ? "업데이트 중…" : "업데이트") {
                updating = true
                Task {
                    await app.applyUpdate()
                    updating = false
                }
            }
            .buttonStyle(.rooms(.primary, .small))
            .disabled(updating)
        }
    }

    private func bar<C: View>(fill: Color, @ViewBuilder _ content: () -> C) -> some View {
        HStack(spacing: 8, content: content)
            .typo(.uiStrong)
            .lineLimit(1)
            .frame(maxWidth: .infinity)
            .frame(height: 28)
            .background(fill, ignoresSafeAreaEdges: [])
    }
}

/// [자세히]: 바뀐 커밋 제목(맥 기본 시트)
struct UpdateDetailSheet: View {
    let update: UpdateState
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text("바뀐 내용").typo(.heading)
                Text("커밋 \(update.count)개").typo(.caption).foregroundStyle(Theme.sub)
            }
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(update.subjects.enumerated()), id: \.offset) { _, s in
                    Text("• \(s)").typo(.ui).lineLimit(2)
                }
                if update.count > update.subjects.count {
                    Text("… 외 \(update.count - update.subjects.count)개").typo(.ui).foregroundStyle(Theme.sub)
                }
            }
            HStack {
                Spacer()
                Button("닫기") { dismiss() }
                    .buttonStyle(.rooms(.secondary, .regular))
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(24)
        .frame(width: 420)
        .background(Theme.bg)
    }
}
