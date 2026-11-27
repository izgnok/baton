import SwiftUI

/// 방 화면 아래 입력창: [Claude/사람] 전환 · 모델·노력 선택 · 여러 줄 입력 · [보내기] (점검표 3.4)
struct Composer: View {
    let model: RoomModel

    private var cm: ComposerModel { model.composer }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let note = cm.note {
                Text(note).typo(.ui).foregroundStyle(Theme.dangerText)
            }
            toolbar
            HStack(alignment: .bottom, spacing: 8) {
                field
                Button("보내기") { cm.send() }
                    .buttonStyle(.rooms(.primary, .big))
                    .disabled(cm.sending)
                    .keyboardShortcut(.return, modifiers: .command) // Enter 는 입력칸이 처리한다
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity)
        .background(Theme.bg)
        .overlay(alignment: .top) { Rectangle().fill(Theme.line).frame(height: 1) }
        .overlay(alignment: .topLeading) {
            if cm.isOpen {
                // 팝업 아래쪽이 입력창 위로 8만큼 겹친다
                AutocompleteView(model: cm)
                    .padding(.leading, 20)
                    .offset(y: 8 - AutocompleteView.height(for: cm.items.count))
            }
        }
        .zIndex(1)
    }

    // MARK: 줄 1: 대상 · 모델 · 노력 · 방 기본과 다를 때 안내

    private var toolbar: some View {
        let dM = model.defaultModel
        let dE = model.defaultEffort
        let mine = model.myModel
        let differs = (!mine.model.isEmpty && mine.model != dM) || (!mine.effort.isEmpty && mine.effort != dE)
        return HStack(spacing: 8) {
            ModeSwitch(mode: cm.mode, onPick: cm.setMode)
            PickMenu(
                title: mine.model.isEmpty ? (dM.isEmpty ? "모델 · 내 설정" : "\(Format.modelLabel(dM)) · 방 기본") : Format.modelLabel(mine.model),
                options: [("", dM.isEmpty ? "내 설정" : "방 기본(\(Format.modelLabel(dM)))")] + modelOptions(mine.model).map { ($0, Format.modelLabel($0)) },
                current: mine.model,
                onPick: { model.saveMyModel(model: $0, effort: mine.effort) })
            PickMenu(
                title: mine.effort.isEmpty ? (dE.isEmpty ? "노력 · 내 설정" : "노력 \(Format.effortLabel(dE)) · 방 기본") : "노력 \(Format.effortLabel(mine.effort))",
                options: [("", dE.isEmpty ? "내 설정" : "방 기본(\(Format.effortLabel(dE)))")] + effortOptions(mine.effort).map { ($0, Format.effortLabel($0)) },
                current: mine.effort,
                onPick: { model.saveMyModel(model: mine.model, effort: $0) })
            if differs {
                let text = "방 기본: \(Self.summary(dM, dE)) · 나: \(Self.summary(mine.model.isEmpty ? dM : mine.model, mine.effort.isEmpty ? dE : mine.effort))"
                HStack(spacing: 8) {
                    Text(text).typo(.caption).foregroundStyle(Theme.sub)
                        .lineLimit(1).truncationMode(.tail).help(text)
                    Button("방 기본으로") { model.saveMyModel(model: "", effort: "") }
                        .buttonStyle(.rooms(.soft, .small))
                        .layoutPriority(1)
                }
                Spacer(minLength: 0)
            } else {
                Spacer(minLength: 0)
            }
        }
        .frame(height: 24)
    }

    /// 저장된 값이 목록에 없어도 보이게
    private func modelOptions(_ current: String) -> [String] {
        current.isEmpty || Format.models.contains(current) ? Format.models : Format.models + [current]
    }

    private func effortOptions(_ current: String) -> [String] {
        current.isEmpty || ComposerModel.efforts.contains(current) ? ComposerModel.efforts : ComposerModel.efforts + [current]
    }

    private static func summary(_ m: String, _ e: String) -> String {
        [Format.modelLabel(m), Format.effortLabel(e)].filter { !$0.isEmpty }.joined(separator: " · ").nonEmpty ?? "내 Claude 설정"
    }

    // MARK: 줄 2: 입력칸

    private var field: some View {
        ComposerField(model: cm)
            .background(RoundedRectangle(cornerRadius: 8).fill(Theme.card))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(cm.focused ? Theme.accent : .clear, lineWidth: 2))
            .overlay(alignment: .leading) {
                if cm.text.isEmpty {
                    Text(cm.placeholder).typo(.body).foregroundStyle(Theme.sub)
                        .padding(.leading, 12).lineLimit(1).allowsHitTesting(false)
                }
            }
    }
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}

/// [Claude/사람] 전환: 높이 24, 선택 칸은 다크에서 바탕보다 밝게(IN6)
private struct ModeSwitch: View {
    let mode: ComposerModel.Mode
    let onPick: (ComposerModel.Mode) -> Void

    var body: some View {
        HStack(spacing: 0) {
            ForEach([(ComposerModel.Mode.claude, "Claude"), (.human, "사람")], id: \.0) { m, label in
                let on = mode == m
                Button { onPick(m) } label: {
                    Text(label).typo(.captionStrong).foregroundStyle(on ? Theme.text : Theme.sub)
                        .padding(.horizontal, 12).frame(height: 20)
                        .background(RoundedRectangle(cornerRadius: 6).fill(on ? Theme.segOn : .clear)
                            .shadow(color: .black.opacity(on ? 0.12 : 0), radius: 1, y: 1))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(2)
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.card))
        .fixedSize()
    }
}

/// 모델·노력 선택 상자: 높이 24. 첫 칸은 방 기본(빈 값)
private struct PickMenu: View {
    let title: String
    let options: [(value: String, label: String)]
    let current: String
    let onPick: (String) -> Void

    var body: some View {
        Menu {
            ForEach(options, id: \.value) { o in
                Button { onPick(o.value) } label: {
                    if o.value == current { Label(o.label, systemImage: "checkmark") } else { Text(o.label) }
                }
            }
        } label: {
            HStack(spacing: 4) {
                Text(title).typo(.caption).foregroundStyle(Theme.text).lineLimit(1)
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 8, weight: .semibold)).foregroundStyle(Theme.sub)
            }
            .padding(.horizontal, 8).frame(height: 24)
            .background(RoundedRectangle(cornerRadius: 6).fill(Theme.card))
            .contentShape(Rectangle())
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
    }
}
