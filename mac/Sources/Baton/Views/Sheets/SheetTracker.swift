import SwiftUI

extension View {
    /// 이 시트가 열려 있는 동안 AppModel.activeSheet 에 알린다
    func trackSheet(_ kind: SheetKind) -> some View { modifier(SheetTracker(kind: kind)) }
}

private struct SheetTracker: ViewModifier {
    let kind: SheetKind
    @Environment(AppModel.self) private var app

    func body(content: Content) -> some View {
        content
            .onAppear { app.sheetOpened(kind) }
            .onDisappear { app.sheetClosed(kind) }
    }
}
