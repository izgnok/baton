import SwiftUI

/// 방 화면: 머리줄 · 채팅 · 입력창 · 오른쪽 패널 자리
struct RoomView: View {
    let app: AppModel
    @Local private var model: RoomModel

    static let tabs = [("repos", "레포"), ("shared", "공유 파일"), ("members", "멤버")]

    init(app: AppModel, id: Int, tab: String) {
        self.app = app
        _model = State(initialValue: RoomModel(roomId: id, app: app, tab: tab))
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
            Text(model.roomName).typo(.heading).foregroundStyle(Theme.text)
                .lineLimit(1).truncationMode(.tail).help(model.roomName)
            Spacer(minLength: 8)
            UsageBars(usage: app.usage, compact: true)
            Text("멤버 \(model.memberCount)명").typo(.ui).foregroundStyle(Theme.sub).fixedSize()
        }
        .padding(.leading, 76) // 왼쪽 위 신호등 버튼 자리
        .padding(.trailing, 16)
        .frame(height: 52)
    }

    // MARK: 오른쪽 패널 자리(탭 이름만. 내용은 다음 단계)

    private var panel: some View {
        VStack(spacing: 0) {
            HStack(spacing: 4) {
                ForEach(Self.tabs, id: \.0) { key, label in
                    let on = model.tab == key
                    Button { model.tab = key } label: {
                        Text(label).typo(on ? .uiStrong : .ui).foregroundStyle(on ? Theme.text : Theme.sub)
                            .padding(.horizontal, 12).frame(height: 43)
                            .overlay(alignment: .bottom) { Rectangle().fill(on ? Theme.accent : .clear).frame(height: 2) }
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            .frame(maxWidth: .infinity)
            Rectangle().fill(Theme.line).frame(height: 1)
            Spacer()
        }
        .background(Theme.bg)
    }
}
