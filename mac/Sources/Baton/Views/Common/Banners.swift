import SwiftUI

/// 화면 맨 위 띠: 연결 끊김, 새 버전, 서버 버전 다름
struct Banners: View {
    let app: AppModel

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
            if app.approvalBlocked {
                bar(fill: Theme.warnSoft) { Text(SheetPolicy.bannerText).foregroundStyle(Theme.warnText) }
            }
            if app.update.available || app.update.serverMismatch {
                // 둘 다 있으면 한 줄에 이어 붙인다(점검표 UB3)
                bar(fill: app.update.serverMismatch ? Theme.warnSoft : Theme.accentSoft) {
                    if app.update.available { updateSegment }
                    if app.update.available && app.update.serverMismatch { Text("·").foregroundStyle(Theme.sub) }
                    if app.update.serverMismatch {
                        Text("서버 버전이 달라요 — 서버를 다시 켜 주세요").foregroundStyle(Theme.warnText)
                    }
                }
            }
        }
        .sheet(isPresented: Binding(get: { app.showUpdateDetail }, set: { app.showUpdateDetail = $0 })) { UpdateSheet(app: app) }
    }

    private var updateSegment: some View {
        HStack(spacing: 8) {
            Text(app.update.count > 0 ? "새 버전이 있어요 (커밋 \(app.update.count)개)" : "앱을 새로 빌드해야 해요").foregroundStyle(Theme.text)
            if app.update.count > 0 {
                Button("자세히") { app.showUpdateDetail = true }.buttonStyle(.baton(.plain, .small))
            }
            Button(app.updating ? "업데이트 중…" : "업데이트") { Task { await app.applyUpdate() } }
                .buttonStyle(.baton(.primary, .small))
                .disabled(app.updating)
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
