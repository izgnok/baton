import AppKit
import SwiftUI

/// 입력칸 NSTextView. 포커스가 오가는 것을 알린다
private final class FieldTextView: NSTextView {
    var onFocus: ((Bool) -> Void)?

    override func becomeFirstResponder() -> Bool {
        let ok = super.becomeFirstResponder()
        if ok { onFocus?(true) }
        return ok
    }

    override func resignFirstResponder() -> Bool {
        let ok = super.resignFirstResponder()
        if ok { onFocus?(false) }
        return ok
    }
}

/// 여러 줄 입력칸: 최소 36 · 최대 160 으로 자동 늘어난다. SwiftUI TextEditor 는 Enter/Shift+Enter 구분·캐럿 위치·한글 조합 확인이 안 돼 NSTextView 를 쓴다
struct ComposerField: NSViewRepresentable {
    let model: ComposerModel

    static let minHeight: CGFloat = 36
    static let maxHeight: CGFloat = 160
    private static let padX: CGFloat = 12

    private static let font = NSFont(name: Fonts.Weight.regular.psName, size: 15) ?? .systemFont(ofSize: 15)
    private static let textColor = NSColor(name: nil) { a in
        a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(hex: 0xECECEF) : NSColor(hex: 0x191F28)
    }

    func makeCoordinator() -> Coordinator { Coordinator(model) }

    func makeNSView(context: Context) -> NSScrollView {
        // TextKit 1 로 만든다(높이를 layoutManager 로 잰다)
        let storage = NSTextStorage()
        let layout = NSLayoutManager()
        let container = NSTextContainer(size: NSSize(width: 400, height: CGFloat.greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        container.widthTracksTextView = true
        storage.addLayoutManager(layout)
        layout.addTextContainer(container)

        let tv = FieldTextView(frame: .zero, textContainer: container)
        tv.delegate = context.coordinator
        tv.isRichText = false
        tv.allowsUndo = true
        tv.drawsBackground = false
        tv.font = Self.font
        tv.textColor = Self.textColor
        tv.insertionPointColor = Self.textColor
        tv.typingAttributes = Self.attributes
        tv.isAutomaticQuoteSubstitutionEnabled = false
        tv.isAutomaticDashSubstitutionEnabled = false
        tv.isAutomaticTextReplacementEnabled = false
        tv.isAutomaticSpellingCorrectionEnabled = false
        tv.isContinuousSpellCheckingEnabled = false
        tv.isVerticallyResizable = true
        tv.isHorizontallyResizable = false
        tv.autoresizingMask = NSView.AutoresizingMask.width
        tv.textContainerInset = NSSize(width: Self.padX, height: ((Self.minHeight - layout.defaultLineHeight(for: Self.font)) / 2).rounded())
        tv.setAccessibilityLabel("메시지 입력")
        tv.onFocus = { [weak c = context.coordinator] on in c?.focusChanged(on) }
        context.coordinator.textView = tv

        let scroll = NSScrollView()
        scroll.documentView = tv
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.scrollerStyle = .overlay
        return scroll
    }

    private static var attributes: [NSAttributedString.Key: Any] { [.font: font, .foregroundColor: textColor] }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let tv = scroll.documentView as? FieldTextView else { return }
        let c = context.coordinator
        c.model = model
        if c.pushed != model.pushSerial { // 모델이 글을 바꿨다
            c.pushed = model.pushSerial
            c.pushing = true
            let full = NSRange(location: 0, length: (tv.string as NSString).length)
            tv.textStorage?.replaceCharacters(in: full, with: NSAttributedString(string: model.text, attributes: Self.attributes))
            tv.setSelectedRange(NSRange(location: min(model.caret, (tv.string as NSString).length), length: 0))
            c.pushing = false
        }
        if c.focusServed != model.focusSerial {
            c.focusServed = model.focusSerial
            DispatchQueue.main.async { tv.window?.makeFirstResponder(tv) }
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView scroll: NSScrollView, context: Context) -> CGSize? {
        let w = proposal.width ?? 400
        guard let tv = scroll.documentView as? NSTextView, let layout = tv.layoutManager, let container = tv.textContainer else { return nil }
        container.containerSize = NSSize(width: max(40, w - Self.padX * 2), height: CGFloat.greatestFiniteMagnitude)
        layout.ensureLayout(for: container)
        let h = ceil(layout.usedRect(for: container).height + tv.textContainerInset.height * 2)
        return CGSize(width: w, height: min(Self.maxHeight, max(Self.minHeight, h)))
    }

    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate {
        var model: ComposerModel
        weak var textView: NSTextView?
        var pushed = 0
        var focusServed = 0
        var pushing = false

        init(_ model: ComposerModel) { self.model = model }

        func focusChanged(_ on: Bool) {
            model.focused = on
            if !on { model.blurred() }
        }

        func textDidChange(_ n: Notification) { report() }

        func textViewDidChangeSelection(_ n: Notification) { report() }

        private func report() {
            guard !pushing, let tv = textView else { return }
            model.edited(text: tv.string, caret: tv.selectedRange().location)
        }

        func textView(_ tv: NSTextView, doCommandBy command: Selector) -> Bool {
            if tv.hasMarkedText() { return false } // 한글 조합 중에는 키를 입력기에 맡긴다(Enter 는 조합 확정일 뿐 보내지 않는다)
            switch command {
            case #selector(NSResponder.insertNewline(_:)):
                if model.isOpen { model.choose(model.selected); return true }
                let flags = NSApp.currentEvent?.modifierFlags ?? []
                if flags.contains(.shift) || flags.contains(.option) {
                    tv.insertNewlineIgnoringFieldEditor(nil) // Shift+Enter 는 줄바꿈
                } else {
                    model.send()
                }
                return true
            case #selector(NSResponder.insertTab(_:)):
                if model.isOpen { model.choose(model.selected) } else { tv.window?.selectNextKeyView(nil) }
                return true
            case #selector(NSResponder.moveDown(_:)):
                guard model.isOpen else { return false }
                model.move(1)
                return true
            case #selector(NSResponder.moveUp(_:)):
                guard model.isOpen else { return false }
                model.move(-1)
                return true
            case #selector(NSResponder.cancelOperation(_:)):
                guard model.isOpen else { return false }
                model.close()
                return true
            default:
                return false
            }
        }
    }
}
