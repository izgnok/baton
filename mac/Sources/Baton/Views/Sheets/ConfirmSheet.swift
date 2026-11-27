import SwiftUI

/// 확인 시트(맥 기본 시트). 삭제·나가기처럼 되돌리기 어려운 동작 앞에 쓴다
struct ConfirmSheet: View {
    let title: String
    let message: String
    let confirmLabel: String
    var danger = false
    let onConfirm: () -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).typo(.heading).foregroundStyle(Theme.text)
            Text(message).typo(.ui).foregroundStyle(Theme.sub)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Spacer()
                Button("취소") { dismiss() }
                    .buttonStyle(.baton(.secondary, .regular))
                    .keyboardShortcut(.cancelAction)
                Button(confirmLabel) { dismiss(); onConfirm() }
                    .buttonStyle(.baton(danger ? .danger : .primary, .regular))
                    .keyboardShortcut(.defaultAction)
            }
            .padding(.top, 8)
        }
        .padding(24)
        .frame(width: 400)
        .background(Theme.bg)
        .trackSheet(.confirm)
    }
}
