import Foundation

/// 바이트를 `\n` 으로 끊는다. 한글이 조각 경계에서 잘려도 줄이 완성된 뒤에 디코드하므로 안전하다.
public struct LineBuffer {
    private var pending = Data()

    public init() {}

    public mutating func append(_ data: Data) -> [Data] {
        var lines: [Data] = []
        var start = data.startIndex
        while let i = data[start...].firstIndex(of: 0x0A) {
            var line = pending
            line.append(data[start..<i])
            pending = Data()
            if !line.isEmpty { lines.append(line) }
            start = i + 1
        }
        pending.append(data[start...])
        return lines
    }
}
