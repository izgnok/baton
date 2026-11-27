import SwiftUI

/// 입력 1칸 + 버튼 두 개 시트(맥 기본 시트). 실패 코드는 `errors` 문구를 먼저 쓰고 없으면 공통 문구
struct InputSheet: View {
    let title: String
    let label: String
    let placeholder: String
    let submitLabel: String
    var errors: [String: String] = [:]
    let onSubmit: (String) async throws -> Void

    @Environment(\.dismiss) private var dismiss
    @Local private var text = ""
    @Local private var busy = false
    @Local private var error = ""
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(title).typo(.heading).foregroundStyle(Theme.text)
            VStack(alignment: .leading, spacing: 8) {
                Text(label).typo(.ui).foregroundStyle(Theme.sub)
                TextField("", text: $text)
                    .placeholder(placeholder, when: text.isEmpty)
                    .textFieldStyle(.plain).typo(.ui).foregroundStyle(Theme.text)
                    .focused($focused)
                    .inputBox(focused: focused)
                    .onSubmit(submit)
                Text(error).typo(.ui).foregroundStyle(Theme.dangerText).frame(minHeight: 20, alignment: .leading)
            }
            HStack(spacing: 8) {
                Spacer()
                Button("취소") { dismiss() }
                    .buttonStyle(.rooms(.secondary, .regular))
                    .keyboardShortcut(.cancelAction)
                Button(submitLabel, action: submit)
                    .buttonStyle(.rooms(.primary, .regular))
                    .keyboardShortcut(.defaultAction)
                    .disabled(busy || text.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(24)
        .frame(width: 400)
        .background(Theme.bg)
        .onAppear { focused = true }
    }

    private func submit() {
        let value = text.trimmingCharacters(in: .whitespaces)
        guard !busy, !value.isEmpty else { return }
        busy = true
        error = ""
        Task {
            do {
                try await onSubmit(value)
                dismiss()
            } catch {
                if case .remote(let code)? = error as? CoreError, let msg = errors[code] { self.error = msg }
                else { self.error = AppModel.message(error) }
                busy = false
            }
        }
    }
}
