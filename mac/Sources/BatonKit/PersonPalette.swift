import Foundation

/// 사람별 고정 색(이름 글자·아바타 바탕). 값은 hex 목록으로만 두고 화면 쪽(Theme)이 Color 로 바꿔 쓴다.
/// 밝게는 #F6F3EC·#FFFDF8, 어둡게는 #1C1B19·#2A2926 위에서 4.5:1 이상(테스트로 확인).
public enum PersonPalette {
    /// 색 순서: 청·적갈·보라·황토·올리브녹·자주
    public static let light: [UInt32] = [0x3A6A8F, 0x8E4A4A, 0x6B5B95, 0x806017, 0x56702A, 0x9A4F73]
    public static let dark: [UInt32] = [0x8DB4D6, 0xD39A93, 0xB5A7DC, 0xD2B16A, 0xA5C277, 0xDDA0C0]
    /// 아바타 위 글자(아바타 색이 이름 색이라 모드마다 반대 밝기)
    public static let onLight: UInt32 = 0xFFFDF8
    public static let onDark: UInt32 = 0x1C1B19
    /// 이름·아바타가 놓이는 바탕(바탕·카드)
    public static let lightBackgrounds: [UInt32] = [0xF6F3EC, 0xFFFDF8]
    public static let darkBackgrounds: [UInt32] = [0x1C1B19, 0x2A2926]
}

/// WCAG 2.x 대비 계산
public enum Contrast {
    /// 상대 휘도(0 검정 ~ 1 흰색)
    public static func luminance(_ hex: UInt32) -> Double {
        func channel(_ shift: UInt32) -> Double {
            let c = Double((hex >> shift) & 0xFF) / 255
            return c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0)
    }

    /// 두 색의 대비비(1 ~ 21)
    public static func ratio(_ a: UInt32, _ b: UInt32) -> Double {
        let (la, lb) = (luminance(a), luminance(b))
        return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
    }
}
