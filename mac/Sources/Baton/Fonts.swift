import AppKit
import SwiftUI
import CoreText

/// 번들의 Pretendard 를 등록한다. 등록에 실패하면 시스템 글꼴을 쓴다.
enum Fonts {
    enum Weight {
        case regular, medium, semibold, bold

        var psName: String {
            switch self {
            case .regular: "Pretendard-Regular"
            case .medium: "Pretendard-Medium"
            case .semibold: "Pretendard-SemiBold"
            case .bold: "Pretendard-Bold"
            }
        }

        var system: Font.Weight {
            switch self {
            case .regular: .regular
            case .medium: .medium
            case .semibold: .semibold
            case .bold: .bold
            }
        }
    }

    /// 처음 읽을 때 한 번 등록한다(static let 이라 스레드 안전).
    static let ready: Bool = {
        guard let dir = Bundle.main.resourceURL?.appendingPathComponent("Fonts") else { return false }
        for w in [Weight.regular, .medium, .semibold, .bold] {
            let url = dir.appendingPathComponent("\(w.psName).otf")
            var err: Unmanaged<CFError>?
            if !CTFontManagerRegisterFontsForURL(url as CFURL, .process, &err) { return false }
        }
        return NSFont(name: Weight.regular.psName, size: 12) != nil
    }()

    static func font(_ size: CGFloat, _ weight: Weight) -> Font {
        ready ? .custom(weight.psName, fixedSize: size) : .system(size: size, weight: weight.system)
    }
}
