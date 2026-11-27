/// 채팅이 새 내용을 따라 맨 아래로 갈지 정한다
public enum ChatFollow {
    /// 방금 열었거나 내가 보냈을 때(stick), 또는 이미 맨 아래를 보고 있을 때만 따라간다. 위로 올려 읽는 중이면 그대로 둔다
    public static func shouldFollow(stick: Bool, atBottom: Bool) -> Bool { stick || atBottom }
}
