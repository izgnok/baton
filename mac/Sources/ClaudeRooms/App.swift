import SwiftUI

@main
struct ClaudeRoomsApp: App {
    @Local private var app = AppModel()

    init() { _ = Fonts.ready }

    var body: some Scene {
        WindowGroup("Claude Rooms") {
            ContentView(app: app)
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1100, height: 728)
        .windowResizability(.contentMinSize)
        .commands { CommandGroup(replacing: .newItem) {} }
    }
}

struct ContentView: View {
    let app: AppModel

    var body: some View {
        VStack(spacing: 0) {
            Banners(app: app)
            switch app.screen {
            case .starting: Color.clear
            case .needNode: NeedNodeView(app: app)
            case .login(let url): LoginView(app: app, serverUrl: url).id(url)
            case .rooms: RoomListView(app: app)
            case .room(let id, let tab, let preview): RoomView(app: app, id: id, tab: tab, preview: preview).id("\(id)/\(tab)/\(preview ?? "")")
            }
        }
        .frame(minWidth: 960, minHeight: 640)
        .background(Theme.bg, ignoresSafeAreaEdges: .all)
        .ignoresSafeArea(.container, edges: .top) // 제목 막대를 숨긴 창이라 내용이 맨 위부터
        .background(alignment: .top) { WindowDragArea().frame(height: 52) } // 신호등 줄·머리줄의 빈 곳을 잡고 창을 옮긴다
        .overlay(alignment: .bottom) { ToastView(text: app.toastText) }
        .animation(.easeOut(duration: 0.2), value: app.toastText)
        .environment(app)
        .onAppear { app.windowReady() }
        .task { await app.start() }
    }
}
