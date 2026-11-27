import SwiftUI
import AppKit

// UI 점검표(docs/2026-11-27-ui-review.md) 2장 기준: 글자 단계·버튼 4단계. 색·모양은 Baton 설계(docs/2026-11-27-baton-design.md 2장)

extension Color {
    init(light: UInt32, dark: UInt32) {
        self.init(nsColor: NSColor.dynamic(light: light, dark: dark))
    }
}

extension NSColor {
    /// 밝게/어둡게 모양에 따라 바뀌는 색
    static func dynamic(light: UInt32, dark: UInt32) -> NSColor {
        NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            return NSColor(hex: isDark ? dark : light)
        }
    }

    convenience init(hex: UInt32) {
        self.init(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                  blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}

/// 색 역할(Baton 설계 2.1). 채움 색과 글자 색을 따로 둔다. 화면 코드는 색 값을 직접 쓰지 않고 여기 이름만 쓴다
enum Theme {
    /// 모서리 반지름 하나(버튼·카드·입력칸·말 상자·배지). 원형 아바타·점·캡슐은 제외. 그림자는 쓰지 않는다
    static let radius: CGFloat = 4

    static let bg = Color(light: 0xF6F3EC, dark: 0x1C1B19)
    /// 오른쪽 패널·작은 버튼 바탕
    static let panel = Color(light: 0xEFEADF, dark: 0x232220)
    static let card = Color(light: 0xFFFDF8, dark: 0x2A2926)
    static let line = Color(light: 0xDDD5C5, dark: 0x3A3833)
    /// 본문 글자(NSTextView 같은 AppKit 쪽은 nsText)
    static let nsText = NSColor.dynamic(light: 0x2A2622, dark: 0xE9E4D8)
    static let text = Color(nsColor: nsText)
    /// 밝게 값은 설계(#7C7365)보다 조금 짙게 — 패널 위에서도 대비 4.5:1 이상(4.70)
    static let sub = Color(light: 0x6F665A, dark: 0xA39B8C)
    /// 막대·포커스 링·선택 탭 밑줄 같은 채움
    static let accent = Color(light: 0x2F6F5E, dark: 0x6FB59E)
    /// 주 버튼 채움
    static let primary = Color(light: 0x2F6F5E, dark: 0x6FB59E)
    static let primaryPress = Color(light: 0x245C4D, dark: 0x5BA08A)
    /// 포인트 위 글자(주 버튼)
    static let onPrimary = Color(light: 0xF6F3EC, dark: 0x1C1B19)
    /// 내 말 상자(두 모드 같은 진녹색)와 그 위 글자
    static let mine = Color(light: 0x2F6F5E, dark: 0x2F6F5E)
    static let onMine = Color(light: 0xF6F3EC, dark: 0xF0ECE2)
    /// 포인트 계열 옅은 바탕(안내 줄·선택 행·방장 배지). 설계 팔레트에 옅은 포인트가 없어 같은 계열로 정했다
    static let accentSoft = Color(light: 0xE3EBE1, dark: 0x26332D)
    static let accentText = Color(light: 0x2F6F5E, dark: 0x6FB59E)
    static let dangerText = Color(light: 0xB4532A, dark: 0xE08A5F)
    /// 성공 표시는 포인트 계열
    static let successText = Color(light: 0x2F6F5E, dark: 0x6FB59E)
    static let warn = Color(light: 0xB4532A, dark: 0xE08A5F)
    static let warnText = Color(light: 0xB4532A, dark: 0xE08A5F)
    /// 경고 계열 옅은 바탕(경고 색 글자가 4.5:1 이상 남도록)
    static let warnSoft = Color(light: 0xFDF4ED, dark: 0x33261F)
    /// 경고 색 줄 위 글자
    static let bannerWarnText = Color(light: 0xFFFDF8, dark: 0x1C1B19)
    /// [Claude/사람] 전환의 선택된 칸
    static let segOn = Color(light: 0xEFEADF, dark: 0x232220)
    /// 카드 위 작은 버튼 바탕
    static let cardButton = Color(light: 0xEFEADF, dark: 0x232220)
    static let usageTrack = Color(light: 0xDDD5C5, dark: 0x3A3833)
}

extension Theme {
    /// 사람별 고정 색 6개: 이름 글자·아바타 바탕. 값은 BatonKit `PersonPalette`(대비 테스트 있음)
    static let personText: [Color] = zip(PersonPalette.light, PersonPalette.dark).map { Color(light: $0, dark: $1) }
    /// 아바타 위 글자
    static let onPerson = Color(light: PersonPalette.onLight, dark: PersonPalette.onDark)
    /// diff 추가·삭제 줄 바탕(성공·경고 계열 옅게)
    static let diffAdd = successText.opacity(0.16)
    static let diffDel = dangerText.opacity(0.16)
}

/// 글자 5단계(2.1)
enum Typo {
    case title, roomTitle, heading, body, ui, uiStrong, caption, captionStrong

    var size: CGFloat {
        switch self {
        case .title: 20
        case .heading, .roomTitle: 16
        case .body: 15
        case .ui, .uiStrong: 13
        case .caption, .captionStrong: 12
        }
    }

    var weight: Fonts.Weight {
        switch self {
        case .title: .bold
        case .roomTitle, .heading, .uiStrong, .captionStrong: .semibold
        case .body, .ui, .caption: .regular
        }
    }

    /// 제목만 세리프(화면 제목·방 제목). 본문은 Pretendard
    var font: Font {
        switch self {
        case .title, .roomTitle: .system(size: size, weight: weight.system, design: .serif)
        default: Fonts.font(size, weight)
        }
    }
}

extension View {
    func typo(_ t: Typo) -> some View { font(t.font) }
}

// MARK: 버튼(2.2)

enum BtnSize {
    case big, regular, small

    var height: CGFloat { switch self { case .big: 36; case .regular: 28; case .small: 24 } }
    var hPad: CGFloat { switch self { case .big: 16; case .regular: 12; case .small: 8 } }
    var font: Font {
        switch self {
        case .big: Fonts.font(14, .semibold)
        case .regular: Fonts.font(13, .semibold)
        case .small: Fonts.font(12, .semibold)
        }
    }
}

enum BtnKind { case primary, secondary, danger, soft, plain, onCard, onCardDanger }

struct BatonButtonStyle: ButtonStyle {
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
            case .primary: Theme.onPrimary
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
                .background(RoundedRectangle(cornerRadius: Theme.radius).fill(background))
                .overlay {
                    // 보통 버튼은 선 테두리(설계 2.3). 주·글자만 있는 종류는 테두리 없음
                    if kind == .secondary || kind == .danger {
                        RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.line, lineWidth: 1)
                    }
                }
                .overlay {
                    if configuration.isPressed && kind != .primary {
                        RoundedRectangle(cornerRadius: Theme.radius).fill(Theme.text.opacity(0.06))
                    }
                }
                .opacity(enabled ? 1 : 0.45)
                .contentShape(RoundedRectangle(cornerRadius: Theme.radius))
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

extension ButtonStyle where Self == BatonButtonStyle {
    static func baton(_ kind: BtnKind = .secondary, _ size: BtnSize = .regular, fill: Bool = false) -> BatonButtonStyle {
        BatonButtonStyle(size: size, kind: kind, fill: fill)
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
            .background(RoundedRectangle(cornerRadius: Theme.radius).fill(Theme.card))
            .overlay(RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(focused ? Theme.accent : .clear, lineWidth: 2))
    }

    /// 빈 입력칸 안내 글. AppKit 이 그리는 prompt 는 포커스 때 강조 색으로 나와 직접 그린다
    func placeholder(_ text: String, when empty: Bool) -> some View {
        overlay(alignment: .leading) {
            if empty { Text(text).typo(.ui).foregroundStyle(Theme.sub).allowsHitTesting(false).padding(.leading, 2) }
        }
    }

    /// 카드: 안쪽 여백 16(본문 카드)
    func card(_ fill: Color = Theme.card, padding: CGFloat = 16) -> some View {
        self.padding(padding).background(RoundedRectangle(cornerRadius: Theme.radius).fill(fill))
            .overlay(RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.line, lineWidth: 1))
    }
}

/// 이 맥의 Command Line Tools 에는 SwiftUI 의 `@State` 매크로 플러그인(SwiftUIMacros)이 없어
/// `@State` 가 컴파일되지 않는다. 같은 속성 래퍼를 타입 별칭으로 쓴다.
typealias Local<Value> = State<Value>
