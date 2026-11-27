import SwiftUI

/// 입력 여러 칸 + 버튼 두 개 시트(맥 기본 시트). 모든 칸이 차야 제출된다
struct FieldsSheet: View {
    struct Field: Identifiable {
        let id: String
        let label: String
        var value = ""
        var placeholder = ""
    }

    let title: String
    let submitLabel: String
    let fields: [Field]
    /// 칸 id → 입력값
    let onSubmit: ([String: String]) async throws -> Void

    @Environment(\.dismiss) private var dismiss
    @Local private var values: [String: String] = [:]
    @Local private var busy = false
    @Local private var error = ""
    @FocusState private var focus: String?

    private func text(_ id: String) -> Binding<String> {
        Binding(get: { values[id] ?? fields.first { $0.id == id }?.value ?? "" }, set: { values[id] = $0 })
    }

    private var complete: Bool {
        fields.allSatisfy { !text($0.id).wrappedValue.trimmingCharacters(in: .whitespaces).isEmpty }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(title).typo(.heading).foregroundStyle(Theme.text)
            ForEach(fields) { f in
                VStack(alignment: .leading, spacing: 8) {
                    Text(f.label).typo(.ui).foregroundStyle(Theme.sub)
                    TextField("", text: text(f.id))
                        .placeholder(f.placeholder, when: text(f.id).wrappedValue.isEmpty)
                        .textFieldStyle(.plain).typo(.ui).foregroundStyle(Theme.text)
                        .focused($focus, equals: f.id)
                        .inputBox(focused: focus == f.id)
                        .onSubmit(submit)
                }
            }
            Text(error).typo(.ui).foregroundStyle(Theme.dangerText).frame(minHeight: 20, alignment: .leading)
            HStack(spacing: 8) {
                Spacer()
                Button("취소") { dismiss() }
                    .buttonStyle(.rooms(.secondary, .regular))
                    .keyboardShortcut(.cancelAction)
                Button(submitLabel, action: submit)
                    .buttonStyle(.rooms(.primary, .regular))
                    .keyboardShortcut(.defaultAction)
                    .disabled(busy || !complete)
            }
        }
        .padding(24)
        .frame(width: 400)
        .background(Theme.bg)
        .onAppear { focus = fields.first?.id }
    }

    private func submit() {
        guard !busy, complete else { return }
        busy = true
        error = ""
        let out = Dictionary(uniqueKeysWithValues: fields.map { ($0.id, text($0.id).wrappedValue.trimmingCharacters(in: .whitespaces)) })
        Task {
            do {
                try await onSubmit(out)
                dismiss()
            } catch {
                self.error = AppModel.message(error)
                busy = false
            }
        }
    }
}
