import Foundation
import Testing
@testable import RoomsKit

@Suite struct RestartPolicyTests {
    @Test func threeInWindowThenStopThenAgain() {
        var p = RestartPolicy()
        let t0 = Date(timeIntervalSince1970: 1000)
        let results = [0.0, 1, 2, 3, 61].map { p.shouldRestart(at: t0.addingTimeInterval($0)) }
        #expect(results == [true, true, true, false, true])
    }
}
