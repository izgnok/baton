import Foundation

/// 공유 파일 미리보기에 쓰는 글 처리
public enum PreviewText {
    public static let limit = 200 * 1024
    public static let cutNote = "… 앞 200KB까지만 보여요"

    /// 앞 `limit` 바이트까지만 글자로 읽는다. 한글이 중간에서 잘리지 않게 글자 경계에서 끊는다
    public static func decode(_ data: Data, limit: Int = PreviewText.limit) -> (text: String, cut: Bool) {
        guard data.count > limit else { return (String(decoding: data, as: UTF8.self), false) }
        let bytes = [UInt8](data.prefix(limit))
        var end = limit
        var i = limit - 1
        var back = 0
        while i >= 0, back < 3, bytes[i] & 0xC0 == 0x80 { i -= 1; back += 1 }
        if i >= 0 {
            let lead = bytes[i]
            let need = lead >= 0xF0 ? 4 : lead >= 0xE0 ? 3 : lead >= 0xC0 ? 2 : 1
            if i + need > limit { end = i }
        }
        return (String(decoding: bytes[..<end], as: UTF8.self), true)
    }

    /// 경로의 파일 이름
    public static func name(_ path: String) -> String {
        path.lastIndex(of: "/").map { String(path[path.index(after: $0)...]) } ?? path
    }

    /// 경로의 폴더("outputs/"). 맨 위 파일이면 빈 값
    public static func folder(_ path: String) -> String {
        path.lastIndex(of: "/").map { String(path[...$0]) } ?? ""
    }
}
