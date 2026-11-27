import SwiftUI
import AppKit

/// 제목 막대를 숨긴 창에서 이 영역의 빈 곳을 잡고 끌면 창이 움직인다
struct WindowDragArea: NSViewRepresentable {
    final class DragView: NSView {
        override var mouseDownCanMoveWindow: Bool { true }
    }

    func makeNSView(context: Context) -> NSView { DragView() }
    func updateNSView(_ nsView: NSView, context: Context) {}
}
