import SwiftUI

/// 입력칸 위 자동완성 팝업(점검표 3.10): 최대 폭 480, 입력창 왼쪽 정렬, 선택 줄은 강조 연한 바탕, 출처 칩 12
struct AutocompleteView: View {
    let model: ComposerModel

    static let rowHeight: CGFloat = 32
    static let maxHeight: CGFloat = 340

    static func height(for count: Int) -> CGFloat { min(maxHeight, CGFloat(count) * rowHeight + 12) }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(Array(model.items.enumerated()), id: \.offset) { i, item in
                        Row(item: item, on: i == model.selected)
                            .id(i)
                            .onTapGesture { model.choose(i) }
                    }
                }
                .padding(6)
            }
            .scrollIndicators(.hidden)
            .onChange(of: model.selected) { proxy.scrollTo(model.selected) }
        }
        .frame(maxWidth: 480)
        .frame(height: Self.height(for: model.items.count))
        .background(RoundedRectangle(cornerRadius: Theme.radius).fill(Theme.bg))
        .overlay(RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.line, lineWidth: 1))
    }

    private struct Row: View {
        let item: Complete.Suggestion
        let on: Bool

        var body: some View {
            HStack(spacing: 8) {
                Text(item.name).typo(.uiStrong).foregroundStyle(Theme.text)
                    .lineLimit(1).truncationMode(.middle).layoutPriority(1)
                Text(item.desc).typo(.caption).foregroundStyle(Theme.sub)
                    .lineLimit(1).truncationMode(.tail)
                Spacer(minLength: 0)
                Text(Complete.sourceText[item.source] ?? item.source).typo(.caption).foregroundStyle(Theme.sub)
                    .padding(.horizontal, 6).padding(.vertical, 1)
                    .background(RoundedRectangle(cornerRadius: Theme.radius).fill(on ? Theme.bg : Theme.card))
                    .fixedSize()
            }
            .padding(.horizontal, 10)
            .frame(height: AutocompleteView.rowHeight)
            .background(RoundedRectangle(cornerRadius: Theme.radius).fill(on ? Theme.accentSoft : .clear))
            .contentShape(Rectangle())
        }
    }
}
