import Foundation

public enum JSON: Codable, Equatable, Sendable {
    case null, bool(Bool), number(Double), string(String), array([JSON]), object([String: JSON])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        // JSONDecoder 는 Bool 을 숫자 1 로, 숫자를 true 로 읽지 않는다(타입 불일치 오류) — 그래서 순서대로 시도해도 구분된다.
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([JSON].self) { self = .array(v) }
        else { self = .object(try c.decode([String: JSON].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        }
    }

    public subscript(key: String) -> JSON? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    public var string: String? { if case .string(let v) = self { v } else { nil } }
    public var bool: Bool? { if case .bool(let v) = self { v } else { nil } }
    public var array: [JSON]? { if case .array(let v) = self { v } else { nil } }
    public var int: Int? {
        if case .number(let v) = self, v == v.rounded(), abs(v) < 9e15 { return Int(v) }
        return nil
    }
}
