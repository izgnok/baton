import SwiftUI

private struct WidthKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

/// 채팅 스크롤. 새 메시지가 오면 맨 아래로 가되, 사용자가 위로 올렸으면 그대로 둔다
struct ChatView: View {
    let model: RoomModel
    @Local private var width: CGFloat = 760
    @Local private var atBottom = true

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    Color.clear.frame(height: 20).id("top")
                    ForEach(Array(model.items.enumerated()), id: \.element.id) { i, item in
                        ChatItemView(item: item, model: model)
                            .padding(.top, i == 0 ? 0 : gap(item))
                            .id(item.id)
                    }
                    Color.clear.frame(height: 20).id("bottom")
                        .onAppear { atBottom = true }
                        .onDisappear { atBottom = false }
                }
                .padding(.horizontal, 20)
                .environment(\.chatWidth, max(320, width - 40))
            }
            .defaultScrollAnchor(.bottom)
            .background(GeometryReader { g in Color.clear.preference(key: WidthKey.self, value: g.size.width) })
            .onPreferenceChange(WidthKey.self) { if $0 > 0 { width = $0 } }
            .onChange(of: model.version) {
                guard ChatFollow.shouldFollow(stick: model.stick, atBottom: atBottom) else { return }
                scrollToBottom(proxy)
                model.stick = false
            }
            .onChange(of: model.scrollRequest) { _, req in
                guard let req else { return }
                Task {
                    try? await Task.sleep(for: .milliseconds(300)) // 방금 펼친 diff 의 높이가 잡힌 뒤
                    switch req.kind {
                    case .top:
                        proxy.scrollTo("top", anchor: .top)
                    case .codeCard:
                        if let id = model.firstCardItemID { proxy.scrollTo(id, anchor: .bottom) }
                    }
                }
            }
        }
    }

    /// 같은 사람이 이어 보낸 메시지는 간격 4, 그 밖은 12
    private func gap(_ item: ChatItem) -> CGFloat {
        switch item {
        case .human(_, let c), .request(_, let c): c ? 4 : 12
        case .claude, .notice: 12
        }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        Task {
            try? await Task.sleep(for: .milliseconds(50)) // 새 내용의 높이가 잡힌 뒤
            proxy.scrollTo("bottom", anchor: .bottom)
        }
    }
}
