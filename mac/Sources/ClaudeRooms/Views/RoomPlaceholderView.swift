import SwiftUI

/// 방 화면은 다음 단계에서 만든다. 지금은 제목과 ← 목록만
struct RoomPlaceholderView: View {
    let app: AppModel
    let id: Int

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Button("← 목록") { app.screen = .rooms }.buttonStyle(.text)
                Text(app.roomNames[id] ?? "").typo(.heading).foregroundStyle(Theme.text).lineLimit(1).truncationMode(.tail)
                Spacer()
            }
            .padding(.horizontal, 16)
            .frame(height: 52)
            Divider()
            Text("방 화면은 다음 단계예요").typo(.ui).foregroundStyle(Theme.sub)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}
