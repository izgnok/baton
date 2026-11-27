import SwiftUI
import AppKit

/// 멤버 탭: 초대 코드 · 멤버 목록(맨 아래 방 나가기) · 방 기본 모델·노력 · 방 설정(방장)
struct MembersPanel: View {
    let model: RoomModel
    @Local private var sheet: MemberSheet?

    private enum MemberSheet: Identifiable {
        case rename, delete, leave
        var id: Self { self }
    }

    private struct Member: Identifiable {
        let id: Int
        let name: String
        let isOwner: Bool
    }

    private var members: [Member] {
        (model.state?["members"]?.array ?? []).compactMap {
            guard let id = $0["userId"]?.int else { return nil }
            return Member(id: id, name: $0["name"]?.string ?? "", isOwner: $0["isOwner"]?.bool ?? false)
        }
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 8) {
                inviteCard
                membersCard
                defaultsCard
                if model.isOwner { settingsCard }
            }
            .padding(12)
        }
        .sheet(item: $sheet) { which in
            switch which {
            case .rename:
                FormSheet(title: "방 이름 바꾸기", submitLabel: "저장", fields: [.init(id: "name", label: "방 이름", value: model.roomName)]) { v in
                    try await model.req("renameRoom", ["name": .string(v["name"] ?? "")], toast: false)
                    model.app.toast("방 이름을 바꿨어요")
                }
            case .delete:
                ConfirmSheet(title: "방을 삭제할까요?", message: "대화와 공유 파일이 모두 사라지고 되돌릴 수 없어요",
                             confirmLabel: "삭제", danger: true) { Task { await deleteRoom() } }
            case .leave:
                ConfirmSheet(title: "방에서 나갈까요?",
                             message: model.isOwner ? "방장이 나가면 먼저 들어온 멤버가 방장이 돼요" : "나간 뒤에도 초대 코드로 다시 들어올 수 있어요",
                             confirmLabel: "나가기", danger: true) { Task { await leaveRoom() } }
            }
        }
    }

    // MARK: 초대 코드(맨 위, MB5)

    private var inviteCard: some View {
        let code = model.state?["room"]?["inviteCode"]?.string ?? ""
        return HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text("초대 코드").typo(.caption).foregroundStyle(Theme.sub)
                Text(code).font(.system(size: 24, weight: .bold, design: .monospaced)).foregroundStyle(Theme.text)
                    .lineLimit(1).textSelection(.enabled)
            }
            Spacer(minLength: 4)
            Button("복사") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(code, forType: .string)
                model.app.toast("초대 코드를 복사했어요")
            }
            .buttonStyle(.baton(.soft, .small))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(padding: 12)
    }

    // MARK: 멤버 목록

    private var membersCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(members.enumerated()), id: \.element.id) { i, m in
                if i > 0 { Rectangle().fill(Theme.line).frame(height: 1).padding(.vertical, 8) }
                memberRow(m)
            }
            // 목록 맨 아래 텍스트 버튼(고정 해제, MB7)
            Rectangle().fill(Theme.line).frame(height: 1).padding(.top, 8)
            Button("방 나가기") { sheet = .leave }
                .buttonStyle(TextButtonStyle(color: Theme.dangerText))
                .padding(.top, 4).padding(.leading, -6)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(padding: 12)
    }

    private func memberRow(_ m: Member) -> some View {
        let mine = m.id == model.me
        let idx = Format.personIndex(m.id)
        let st = model.memberStatus[m.id]
        let lines = Format.memberSummaryLines(st)
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(Format.initial(m.name)).font(Fonts.font(11, .bold)).foregroundStyle(mine ? .white : Theme.onPerson)
                    .frame(width: 20, height: 20).background(Circle().fill(mine ? Theme.primary : Theme.personText[idx]))
                Text(m.name).typo(.uiStrong).foregroundStyle(Theme.text).lineLimit(1).truncationMode(.tail)
                if m.isOwner {
                    Text("방장").typo(.captionStrong).foregroundStyle(Theme.accentText)
                        .padding(.horizontal, 8).frame(height: 20)
                        .background(RoundedRectangle(cornerRadius: 6).fill(Theme.accentSoft))
                }
                Spacer(minLength: 0)
            }
            // 이름표 붙은 짧은 줄, 각 한 줄 말줄임(MB1)
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Array(lines.enumerated()), id: \.offset) { i, line in
                    let off = st != nil && i == 2 && !st!.claude
                    Text(line).typo(.caption).foregroundStyle(off ? Theme.warnText : Theme.sub)
                        .lineLimit(1).truncationMode(.tail)
                }
            }
            .padding(.leading, 28)
            .help(Format.memberSummary(st))
        }
    }

    // MARK: 방 기본 모델·노력

    private var defaultsCard: some View {
        let dM = model.defaultModel
        let dE = model.defaultEffort
        return VStack(alignment: .leading, spacing: 8) {
            Text("방 기본 모델·노력").typo(.uiStrong).foregroundStyle(Theme.text)
            if model.isOwner {
                Text("각자 입력창에서 바꿀 수 있어요").typo(.caption).foregroundStyle(Theme.sub).lineLimit(1)
                HStack(spacing: 8) {
                    Text("모델").typo(.caption).foregroundStyle(Theme.sub).frame(width: 28, alignment: .leading)
                    PickMenu(
                        title: dM.isEmpty ? "각자 Claude 설정" : Format.modelLabel(dM),
                        options: [("", "각자 Claude 설정")] + (Format.models.contains(dM) || dM.isEmpty ? Format.models : Format.models + [dM]).map { ($0, Format.modelLabel($0)) },
                        current: dM,
                        onPick: { save(["defaultModel": .string($0)]) })
                }
                HStack(spacing: 8) {
                    Text("노력").typo(.caption).foregroundStyle(Theme.sub).frame(width: 28, alignment: .leading)
                    PickMenu(
                        title: dE.isEmpty ? "각자 Claude 설정" : Format.effortLabel(dE),
                        options: [("", "각자 Claude 설정")] + (ComposerModel.efforts.contains(dE) || dE.isEmpty ? ComposerModel.efforts : ComposerModel.efforts + [dE]).map { ($0, Format.effortLabel($0)) },
                        current: dE,
                        onPick: { save(["defaultEffort": .string($0)]) })
                }
            } else {
                Text(PanelText.modelSummary(model: dM, effort: dE)).typo(.ui).foregroundStyle(Theme.sub).lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(padding: 12)
    }

    private func save(_ patch: [String: JSON]) {
        Task {
            if (try? await model.req("setRoomSettings", patch)) != nil { model.app.toast("방 기본을 바꿨어요") }
        }
    }

    private func setPublic(_ on: Bool) {
        Task {
            if (try? await model.req("setRoomSettings", ["isPublic": .bool(on)])) != nil { model.app.toast(PanelText.publicToast(on)) }
        }
    }

    // MARK: 방 설정(방장만)

    private var settingsCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("방 설정").typo(.uiStrong).foregroundStyle(Theme.text)
            Toggle(isOn: Binding(get: { model.isPublic }, set: { setPublic($0) })) {
                Text("공개 방").typo(.ui).foregroundStyle(Theme.text)
            }
            .toggleStyle(.switch)
            Text("켜 두면 초대 코드 없이 목록에서 참가할 수 있어요").typo(.caption).foregroundStyle(Theme.sub)
                .lineLimit(2).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Button("초대 코드 바꾸기") {
                    Task { if (try? await model.req("regenerateInvite")) != nil { model.app.toast("초대 코드를 새로 만들었어요") } }
                }
                .buttonStyle(.baton(.onCard, .small))
                Button("방 이름 바꾸기") { sheet = .rename }
                    .buttonStyle(.baton(.onCard, .small))
            }
            Button("방 삭제") { sheet = .delete }
                .buttonStyle(.baton(.onCardDanger, .small))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(padding: 12)
    }

    // MARK: 나가기·삭제

    private func kept(_ r: JSON) -> [PanelText.Kept] {
        (r["keptWorktrees"]?.array ?? []).map { PanelText.Kept(name: $0["name"]?.string ?? "", reason: $0["reason"]?.string ?? "") }
    }

    private func deleteRoom() async {
        model.leaving = true
        do {
            let r = try await model.req("deleteRoom")
            model.app.toast(PanelText.keptNote("방을 삭제했어요", kept: kept(r)))
            model.app.screen = .rooms
        } catch { model.leaving = false }
    }

    private func leaveRoom() async {
        guard let r = try? await model.req("leaveRoom") else { return }
        model.app.toast(PanelText.keptNote("방에서 나왔어요", kept: kept(r)))
        model.app.screen = .rooms
    }
}
