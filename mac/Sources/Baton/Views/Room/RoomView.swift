import SwiftUI

/// 방 화면: 머리줄 · 채팅 · 입력창 · 오른쪽 패널 자리
struct RoomView: View {
    let app: AppModel
    @Local private var model: RoomModel
    @Local private var forkOpen = false

    static let tabs = [("repos", "레포"), ("shared", "공유 파일"), ("members", "멤버")]

    init(app: AppModel, id: Int, tab: String, preview: String? = nil) {
        self.app = app
        _model = State(initialValue: RoomModel(roomId: id, app: app, tab: tab, preview: preview))
    }

    private struct PreviewItem: Identifiable { let id: String }

    private var previewItem: Binding<PreviewItem?> {
        Binding(get: { model.preview.map(PreviewItem.init) }, set: { if $0 == nil { model.preview = nil } })
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Rectangle().fill(Theme.line).frame(height: 1)
            HStack(spacing: 0) {
                VStack(spacing: 0) {
                    ChatView(model: model)
                    Composer(model: model)
                }
                Rectangle().fill(Theme.line).frame(width: 1)
                panel.frame(width: 300)
            }
        }
        .environment(\.openURL, OpenURLAction { url in
            MainActor.assumeIsolated { MacActions.openURL(url) }
            return .handled
        })
        .tint(Theme.accentText)
        .sheet(item: previewItem) { PreviewSheet(model: model, path: $0.id) }
        .sheet(isPresented: $forkOpen) {
            FormSheet(
                title: "이 대화로 새 방 만들기", submitLabel: "새 방 만들기",
                fields: [.init(id: "name", label: "새 방 이름", value: PanelText.forkDefaultName(model.roomName))],
                onSubmit: { v in
                    let room = try await model.req("forkRoom", ["name": .string(v["name"] ?? "")], toast: false)
                    app.toast("새 방을 만들었어요")
                    if let id = room["id"]?.int { app.openRoom(id) }
                })
        }
        .task {
            app.currentRoom = model
            await model.start()
        }
        .onDisappear { if app.currentRoom === model { app.currentRoom = nil } }
        .onChange(of: app.roomEvents[model.roomId]?.count ?? 0) {
            model.ingest(app.takeRoomEvents(model.roomId))
        }
        .onChange(of: app.connected) { old, new in
            if new && !old { Task { await model.load() } } // 연결이 돌아오면 다시 읽는다
        }
    }

    // MARK: 머리줄

    private var header: some View {
        HStack(spacing: 12) {
            Button("← 목록") { app.screen = .rooms }.buttonStyle(.text)
            Text(model.roomName).typo(.roomTitle).foregroundStyle(Theme.text)
                .lineLimit(1).truncationMode(.tail).help(model.roomName)
            Spacer(minLength: 8)
            if let c = model.context {
                let window = Format.contextWindow(c.model)
                let fraction = Double(c.tokens) / Double(window)
                VStack(alignment: .leading, spacing: 4) {
                    Text(Format.contextLabel(tokens: c.tokens, model: c.model)).typo(.caption).foregroundStyle(Theme.text).lineLimit(1)
                    UsageBars.Bar(fraction: fraction, warn: fraction >= 0.8)
                }
                .frame(width: 150, alignment: .leading)
                .help("방 멤버 모두 같은 대화를 이어 써서 같은 값이에요. 많이 차면 /compact 로 줄일 수 있어요")
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    Text(model.contextEmptyText).typo(.caption).foregroundStyle(Theme.sub).lineLimit(1)
                    UsageBars.Bar(fraction: 0, warn: false)
                }
                .frame(width: 150, alignment: .leading)
                .help("Claude가 이 방에서 답하면 그때부터 컨텍스트 크기가 보여요")
            }
            UsageBars(usage: app.usage, compact: true)
            Text(PanelText.memberCountText(model.memberCount)).typo(.ui).foregroundStyle(Theme.sub).fixedSize()
            moreMenu
        }
        .padding(.leading, 76) // 왼쪽 위 신호등 버튼 자리
        .padding(.trailing, 16)
        .frame(height: 52)
    }

    private var moreMenu: some View {
        Menu {
            Button("이 대화로 새 방 만들기") { forkOpen = true }
        } label: {
            Image(systemName: "ellipsis").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.sub)
                .frame(width: 24, height: 24).contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("더 보기")
    }

    // MARK: 오른쪽 패널

    private var panel: some View {
        VStack(spacing: 0) {
            HStack(spacing: 4) {
                ForEach(Self.tabs, id: \.0) { key, label in
                    let on = model.tab == key
                    Button { model.tab = key } label: {
                        Text(label).typo(on ? .uiStrong : .ui).foregroundStyle(on ? Theme.text : Theme.sub)
                            .padding(.horizontal, 12).frame(height: 43)
                            .overlay(alignment: .bottom) { Rectangle().fill(on ? Theme.primary : .clear).frame(height: 2) }
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            .frame(maxWidth: .infinity)
            Rectangle().fill(Theme.line).frame(height: 1)
            switch model.tab {
            case "repos": ReposPanel(model: model)
            case "shared": SharedPanel(model: model)
            default: MembersPanel(model: model)
            }
        }
        .background(Theme.panel)
    }
}
