import Testing
@testable import RoomsKit

@Suite struct ChatFollowTests {
    @Test func followsOnlyAtBottomOrWhenSticking() {
        #expect(ChatFollow.shouldFollow(stick: false, atBottom: true))
        #expect(!ChatFollow.shouldFollow(stick: false, atBottom: false)) // 위로 올려 읽는 중
        #expect(ChatFollow.shouldFollow(stick: true, atBottom: false)) // 방금 열었거나 내가 보냄
        #expect(ChatFollow.shouldFollow(stick: true, atBottom: true))
    }
}
