import SwiftUI

/// [자세히]: 바뀐 커밋 제목 목록(맥 기본 시트)과 [업데이트]
struct UpdateSheet: View {
    let app: AppModel
    @Environment(\.dismiss) private var dismiss

    private var update: UpdateState { app.update }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text("바뀐 내용").typo(.heading).foregroundStyle(Theme.text)
                Text("커밋 \(update.count)개").typo(.caption).foregroundStyle(Theme.sub)
            }
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(update.subjects.enumerated()), id: \.offset) { _, s in
                    Text("• \(s)").typo(.ui).foregroundStyle(Theme.text).lineLimit(2)
                }
                if update.count > update.subjects.count {
                    Text("… 외 \(update.count - update.subjects.count)개").typo(.ui).foregroundStyle(Theme.sub)
                }
            }
            HStack(spacing: 8) {
                Spacer()
                Button("닫기") { dismiss() }
                    .buttonStyle(.baton(.secondary, .regular))
                    .keyboardShortcut(.cancelAction)
                Button(app.updating ? "업데이트 중…" : "업데이트") {
                    dismiss()
                    Task { await app.applyUpdate() }
                }
                .buttonStyle(.baton(.primary, .regular))
                .keyboardShortcut(.defaultAction)
                .disabled(app.updating)
            }
        }
        .padding(24)
        .frame(width: 420)
        .background(Theme.bg)
        .trackSheet(.update)
    }
}
