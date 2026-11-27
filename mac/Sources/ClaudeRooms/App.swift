import SwiftUI

@main
struct ClaudeRoomsApp: App {
    @Local private var app = AppModel()

    init() { _ = Fonts.ready }

    var body: some Scene {
        WindowGroup("Claude Rooms") {
            ContentView(app: app)
        }
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
            case .room(let id, _, _): RoomPlaceholderView(app: app, id: id)
            }
        }
        .frame(minWidth: 960, minHeight: 640)
        .background(Theme.bg)
        .overlay(alignment: .bottom) { ToastView(text: app.toastText) }
        .animation(.easeOut(duration: 0.2), value: app.toastText)
        .onAppear { app.windowReady() }
        .task { await app.start() }
    }
}
