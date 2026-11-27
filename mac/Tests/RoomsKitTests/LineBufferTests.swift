import Foundation
import Testing
@testable import RoomsKit

@Suite struct LineBufferTests {
    @Test func splitsAndKeepsPartial() {
        var b = LineBuffer()
        #expect(b.append(Data("a\nb".utf8)) == [Data("a".utf8)])
        #expect(b.append(Data("c\n".utf8)) == [Data("bc".utf8)])
        #expect(b.append(Data("\n\nx\n".utf8)) == [Data("x".utf8)])  // 빈 줄은 버린다
    }

    @Test func koreanSplitMidCharacter() {
        let bytes = Array("한글\n".utf8)  // 한 = 3바이트
        var b = LineBuffer()
        #expect(b.append(Data(bytes[0..<2])) == [])
        let lines = b.append(Data(bytes[2...]))
        #expect(lines.map { String(decoding: $0, as: UTF8.self) } == ["한글"])
    }
}
