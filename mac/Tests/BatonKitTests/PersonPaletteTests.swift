import Testing
@testable import BatonKit

@Suite struct PersonPaletteTests {
    @Test func contrastBasics() {
        #expect(abs(Contrast.ratio(0x000000, 0xFFFFFF) - 21) < 0.001)
        #expect(abs(Contrast.ratio(0x777777, 0x777777) - 1) < 0.001)
        // 순서를 바꿔도 같다
        #expect(Contrast.ratio(0xF6F3EC, 0x2A2622) == Contrast.ratio(0x2A2622, 0xF6F3EC))
    }

    @Test func paletteSize() {
        #expect(PersonPalette.light.count == PersonPalette.dark.count)
        #expect(PersonPalette.light.count == 6) // Format.personIndex 가 0...5
    }

    @Test func nameColorsReadableOnBackgrounds() {
        for (colors, backgrounds) in [(PersonPalette.light, PersonPalette.lightBackgrounds), (PersonPalette.dark, PersonPalette.darkBackgrounds)] {
            for c in colors { for bg in backgrounds { #expect(Contrast.ratio(c, bg) >= 4.5, "\(String(c, radix: 16)) on \(String(bg, radix: 16))") } }
        }
    }

    @Test func avatarTextReadableOnAvatar() {
        for c in PersonPalette.light { #expect(Contrast.ratio(PersonPalette.onLight, c) >= 4.5) }
        for c in PersonPalette.dark { #expect(Contrast.ratio(PersonPalette.onDark, c) >= 4.5) }
    }
}
