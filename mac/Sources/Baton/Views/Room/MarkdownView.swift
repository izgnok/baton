import SwiftUI

/// 마크다운 블록을 SwiftUI 로 그린다. 제목 크기는 점검표 2.1(h1 17 · h2 15 · h3 15)
struct MarkdownView: View {
    let blocks: [MarkdownBlock]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { i, block in
                blockView(block).padding(.top, i > 0 && isHeading(block) ? 8 : 0)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
    }

    private func isHeading(_ b: MarkdownBlock) -> Bool { if case .heading = b { true } else { false } }

    @ViewBuilder
    private func blockView(_ block: MarkdownBlock) -> some View {
        switch block {
        case .heading(let level, let text):
            Text(MarkdownStyle.apply(text, size: 15, weight: level <= 2 ? .bold : .semibold, color: Theme.text, sizeOverride: level == 1 ? 17 : 15))
                .lineSpacing(4)
        case .paragraph(let text):
            Text(MarkdownStyle.apply(text, size: 15, weight: .regular, color: Theme.text)).lineSpacing(5)
        case .listItem(let ordered, let index, let depth, let text):
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(ordered ? "\(index)." : (depth == 0 ? "•" : "◦"))
                    .font(Fonts.font(15, .regular)).foregroundStyle(Theme.sub)
                    .frame(width: 24, alignment: .trailing)
                Text(MarkdownStyle.apply(text, size: 15, weight: .regular, color: Theme.text)).lineSpacing(5)
            }
            .padding(.leading, CGFloat(depth) * 24)
        case .quote(let text):
            HStack(alignment: .top, spacing: 12) {
                Rectangle().fill(Theme.line).frame(width: 3)
                Text(MarkdownStyle.apply(text, size: 15, weight: .regular, color: Theme.sub)).lineSpacing(5)
            }
            .fixedSize(horizontal: false, vertical: true)
        case .code(_, let text):
            CodeBlockView(text: text)
        case .table(let header, let rows):
            tableView(header: header, rows: rows)
        case .rule:
            Rectangle().fill(Theme.line).frame(height: 1).padding(.vertical, 4)
        }
    }

    private func tableView(header: [AttributedString], rows: [[AttributedString]]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                GridRow { ForEach(Array(header.enumerated()), id: \.offset) { _, c in cell(c, bold: true) } }
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    GridRow { ForEach(Array(row.enumerated()), id: \.offset) { _, c in cell(c, bold: false) } }
                }
            }
            .overlay(Rectangle().strokeBorder(Theme.line, lineWidth: 1))
        }
    }

    private func cell(_ text: AttributedString, bold: Bool) -> some View {
        Text(MarkdownStyle.apply(text, size: 13, weight: bold ? .semibold : .regular, color: Theme.text))
            .padding(.horizontal, 12).padding(.vertical, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(Rectangle().strokeBorder(Theme.line, lineWidth: 0.5))
    }
}

/// 코드 블록: 12/18 고정폭, 줄바꿈 없이 가로 스크롤
struct CodeBlockView: View {
    let text: String

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(text.isEmpty ? " " : text)
                .font(.system(size: 12, design: .monospaced))
                .lineSpacing(18 - 14.3) // 12px 고정폭의 글자 높이(약 14.3) 위에 줄 높이 18
                .foregroundStyle(Theme.text)
                .fixedSize(horizontal: true, vertical: true)
                .textSelection(.enabled)
                .padding(.horizontal, 16).padding(.vertical, 12)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Theme.radius).fill(Theme.card))
    }
}

/// 인라인 서식(굵게·기울임·코드·취소선·링크)을 Pretendard 글꼴·색으로 바꾼다
enum MarkdownStyle {
    static func apply(_ source: AttributedString, size: CGFloat, weight: Fonts.Weight, color: Color, sizeOverride: CGFloat? = nil) -> AttributedString {
        var out = source
        let base = sizeOverride ?? size
        for run in source.runs {
            let intent = run.inlinePresentationIntent ?? []
            var font: Font
            if intent.contains(.code) {
                font = .system(size: base - 1, design: .monospaced)
                out[run.range].backgroundColor = Theme.card
            } else {
                let strong = intent.contains(.stronglyEmphasized)
                font = Fonts.font(base, strong && weight == .regular ? .bold : weight)
            }
            if intent.contains(.emphasized) { font = font.italic() }
            out[run.range].font = font
            out[run.range].foregroundColor = color
            if intent.contains(.strikethrough) { out[run.range].strikethroughStyle = .single }
            if run.link != nil {
                out[run.range].foregroundColor = Theme.accentText
                out[run.range].underlineStyle = .single
            }
        }
        return out
    }
}
