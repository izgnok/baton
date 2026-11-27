import Foundation
import Testing
@testable import RoomsKit

@Suite struct JSONTests {
    @Test func boolAndNumberStayDistinct() throws {
        let v = try JSONDecoder().decode(JSON.self, from: Data(#"{"t":true,"f":false,"one":1,"zero":0,"n":null,"s":"한글","a":[1,"x"],"d":1.5}"#.utf8))
        #expect(v["t"] == .bool(true))
        #expect(v["f"] == .bool(false))
        #expect(v["one"] == .number(1))
        #expect(v["zero"] == .number(0))
        #expect(v["n"] == .null)
        #expect(v["s"]?.string == "한글")
        #expect(v["one"]?.int == 1)
        #expect(v["d"]?.int == nil)
        #expect(v["one"]?.bool == nil)
        #expect(v["t"]?.bool == true)
        #expect(v["a"]?.array?.count == 2)
    }

    @Test func roundTrip() throws {
        let v: JSON = .object(["a": .array([.number(1), .bool(true), .null, .string("x")])])
        #expect(try JSONDecoder().decode(JSON.self, from: JSONEncoder().encode(v)) == v)
    }
}
