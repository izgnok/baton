import SwiftUI
import AppKit

// UI 점검표(docs/2026-11-27-ui-review.md) 2장 기준: 색 토큰·글자 단계·버튼 4단계

extension Color {
    init(light: UInt32, dark: UInt32) {
        self.init(nsColor: NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            return NSColor(hex: isDark ? dark : light)
        })
    }
}

extension NSColor {
    convenience init(hex: UInt32) {
        self.init(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                  blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}

/// 색 역할(2.4). 채움 색과 글자 색을 따로 둔다
enum Theme {
    static let bg = Color(light: 0xFFFFFF, dark: 0x17171C)
    static let card = Color(light: 0xF2F4F6, dark: 0x202027)
    static let line = Color(light: 0xE5E8EB, dark: 0x2C2C35)
    static let text = Color(light: 0x191F28, dark: 0xECECEF)
    static let sub = Color(light: 0x6B7684, dark: 0x7E8590)
    /// 막대·포커스 링 같은 채움
    static let accent = Color(light: 0x3182F6, dark: 0x3182F6)
    /// 주 버튼 채움(5장 2번 B)
    static let primary = Color(light: 0x1B64DA, dark: 0x1B64DA)
    static let primaryPress = Color(light: 0x1654B8, dark: 0x1654B8)
    static let accentSoft = Color(light: 0xE8F3FF, dark: 0x1B2A44)
    static let accentText = Color(light: 0x1B64DA, dark: 0x5BA3FF)
    static let dangerText = Color(light: 0xD22030, dark: 0xFF6B76)
    static let successText = Color(light: 0x02804E, dark: 0x03B26C)
    static let warn = Color(light: 0xFF9F00, dark: 0xFF9F00)
    static let warnText = Color(light: 0x9A5A00, dark: 0xFFB340)
    static let warnSoft = Color(light: 0xFFF1D6, dark: 0x3A2A1A)
    static let bannerWarnText = Color(light: 0x3B2A00, dark: 0x3B2A00)
    /// [Claude/사람] 전환의 선택된 칸(다크에서 바탕보다 밝게)
    static let segOn = Color(light: 0xFFFFFF, dark: 0x3A3A45)
    /// 카드 위 작은 버튼 바탕(다크에서 카드보다 밝게, DK3)
    static let cardButton = Color(light: 0xFFFFFF, dark: 0x2C2C35)
    static let usageTrack = Color(light: 0xE5E8EB, dark: 0x3A3A45)
}

/// 글자 5단계(2.1)
enum Typo {
    case title, heading, body, ui, uiStrong, caption, captionStrong

    var size: CGFloat {
        switch self {
        case .title: 20
        case .heading: 16
        case .body: 15
        case .ui, .uiStrong: 13
        case .caption, .captionStrong: 12
        }
    }

    var weight: Fonts.Weight {
        switch self {
        case .title: .bold
        case .heading, .uiStrong, .captionStrong: .semibold
        case .body, .ui, .caption: .regular
        }
    }

    var font: Font { Fonts.font(size, weight) }
}

extension View {
    func typo(_ t: Typo) -> some View { font(t.font) }
}

// MARK: 버튼(2.2)

enum BtnSize {
    case big, regular, small

    var height: CGFloat { switch self { case .big: 36; case .regular: 28; case .small: 24 } }
    var hPad: CGFloat { switch self { case .big: 16; case .regular: 12; case .small: 8 } }
    var radius: CGFloat { switch self { case .big: 10; case .regular: 8; case .small: 6 } }
    var font: Font {
        switch self {
        case .big: Fonts.font(14, .semibold)
        case .regular: Fonts.font(13, .semibold)
        case .small: Fonts.font(12, .semibold)
        }
    }
}

enum BtnKind { case primary, secondary, danger, soft, plain, onCard, onCardDanger }

struct RoomsButtonStyle: ButtonStyle {
    var size: BtnSize = .regular
    var kind: BtnKind = .secondary
    /// 가로 전체 폭은 로그인 폼만 쓴다
    var fill = false

    func makeBody(configuration: Configuration) -> some View {
        StyleBody(configuration: configuration, size: size, kind: kind, fill: fill)
    }

    private struct StyleBody: View {
        let configuration: Configuration
        let size: BtnSize
        let kind: BtnKind
        let fill: Bool
        @Environment(\.isEnabled) private var enabled

        private var background: Color {
            switch kind {
            case .primary: configuration.isPressed ? Theme.primaryPress : Theme.primary
            case .secondary, .danger: Theme.card
            case .plain: Theme.bg
            case .onCard, .onCardDanger: Theme.cardButton
            case .soft: Theme.accentSoft
            }
        }

        private var foreground: Color {
            switch kind {
            case .primary: .white
            case .secondary, .plain, .onCard: Theme.text
            case .danger, .onCardDanger: Theme.dangerText
            case .soft: Theme.accentText
            }
        }

        var body: some View {
            configuration.label
                .font(size.font)
                .foregroundStyle(foreground)
                .lineLimit(1)
                .padding(.horizontal, size.hPad)
                .frame(maxWidth: fill ? .infinity : nil)
                .frame(height: size.height)
                .background(RoundedRectangle(cornerRadius: size.radius).fill(background))
                .overlay {
                    if configuration.isPressed && kind != .primary {
                        RoundedRectangle(cornerRadius: size.radius).fill(Color.black.opacity(0.06))
                    }
                }
                .opacity(enabled ? 1 : 0.45)
                .contentShape(RoundedRectangle(cornerRadius: size.radius))
        }
    }
}

/// 텍스트 버튼: 누르는 영역 24, 13 Medium, 보조 색(올리면 본문 색)
struct TextButtonStyle: ButtonStyle {
    var color: Color? = nil

    func makeBody(configuration: Configuration) -> some View {
        StyleBody(configuration: configuration, color: color)
    }

    private struct StyleBody: View {
        let configuration: Configuration
        let color: Color?
        @Environment(\.isEnabled) private var enabled
        @Local private var hover = false

        var body: some View {
            configuration.label
                .font(Fonts.font(13, .medium))
                .foregroundStyle(color ?? (hover || configuration.isPressed ? Theme.text : Theme.sub))
                .padding(.horizontal, 6)
                .frame(minHeight: 24)
                .contentShape(Rectangle())
                .opacity(enabled ? 1 : 0.45)
                .onHover { hover = $0 }
        }
    }
}

extension ButtonStyle where Self == RoomsButtonStyle {
    static func rooms(_ kind: BtnKind = .secondary, _ size: BtnSize = .regular, fill: Bool = false) -> RoomsButtonStyle {
        RoomsButtonStyle(size: size, kind: kind, fill: fill)
    }
}

extension ButtonStyle where Self == TextButtonStyle {
    static var text: TextButtonStyle { TextButtonStyle() }
}

// MARK: 입력·카드

extension View {
    /// 폼 입력 32(2.2). 포커스면 강조 테두리
    func inputBox(focused: Bool) -> some View {
        padding(.horizontal, 12)
            .frame(height: 32)
            .background(RoundedRectangle(cornerRadius: 8).fill(Theme.card))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(focused ? Theme.accent : .clear, lineWidth: 2))
    }

    /// 빈 입력칸 안내 글. AppKit 이 그리는 prompt 는 포커스 때 강조 색으로 나와 직접 그린다
    func placeholder(_ text: String, when empty: Bool) -> some View {
        overlay(alignment: .leading) {
            if empty { Text(text).typo(.ui).foregroundStyle(Theme.sub).allowsHitTesting(false).padding(.leading, 2) }
        }
    }

    /// 카드: 모서리 12, 안쪽 여백 16(본문 카드)
    func card(_ fill: Color = Theme.card, padding: CGFloat = 16) -> some View {
        self.padding(padding).background(RoundedRectangle(cornerRadius: 12).fill(fill))
    }
}

/// 이 맥의 Command Line Tools 에는 SwiftUI 의 `@State` 매크로 플러그인(SwiftUIMacros)이 없어
/// `@State` 가 컴파일되지 않는다. 같은 속성 래퍼를 타입 별칭으로 쓴다.
typealias Local<Value> = State<Value>
