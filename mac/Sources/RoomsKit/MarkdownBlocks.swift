import Foundation

/// 마크다운을 화면 블록으로 나눈 결과. 인라인(굵게·코드·링크)은 AttributedString 에 남는다
public enum MarkdownBlock: Equatable, Sendable {
    case heading(level: Int, AttributedString)
    case paragraph(AttributedString)
    case listItem(ordered: Bool, index: Int, depth: Int, AttributedString)
    case quote(AttributedString)
    case code(language: String?, text: String)
    case table(header: [AttributedString], rows: [[AttributedString]])
    case rule
}

private enum Leaf { case paragraph, heading(Int), code(String?), rule, cell, html }

/// 한 줄(런) 조각의 위치 정보. 가장 안쪽 블록(leaf)과 둘러싼 목록·인용·표를 함께 든다
private struct Unit {
    var id: Int
    var leaf: Leaf
    var text = AttributedString()
    var itemID: Int?
    var ordinal = 0
    var lists: [Bool] = [] // 바깥→안쪽 순서가 아니라 만나는 순서(안쪽 먼저), true = 순서 있는 목록
    var quote = false
    var tableID: Int?
    var columns = 0
    var headerRow = false
    var row = 0
    var col = 0
}

private let allowedSchemes: Set<String> = ["http", "https"]

/// `AttributedString` 마크다운 해석(.full)의 `presentationIntent` 를 블록으로 묶는다.
/// - 원문 HTML 은 해석기가 태그를 글자(inlineHTML·blockHTML)로 남긴다 — 블록 HTML 은 코드 블록처럼 글자로 낸다
/// - 링크는 http/https 만 남기고, 이미지는 대체 글자만 남긴다
public func markdownBlocks(_ text: String) -> [MarkdownBlock] {
    let opts = AttributedString.MarkdownParsingOptions(interpretedSyntax: .full, failurePolicy: .returnPartiallyParsedIfPossible)
    guard let parsed = try? AttributedString(markdown: text, options: opts) else {
        return text.isEmpty ? [] : [.paragraph(AttributedString(text))]
    }

    var units: [Unit] = []
    var anonymous = 0
    for run in parsed.runs {
        let inline = run.inlinePresentationIntent ?? []
        var piece: AttributedString
        if inline.contains(.softBreak) || inline.contains(.lineBreak) {
            piece = AttributedString("\n") // 줄바꿈은 그대로 보인다(Electron 쪽 breaks: true 와 같음)
        } else {
            piece = AttributedString(parsed[run.range])
            if let url = piece.link, !allowedSchemes.contains(url.scheme?.lowercased() ?? "") { piece.link = nil }
            piece.imageURL = nil
        }
        piece.presentationIntent = nil

        var u = Unit(id: 0, leaf: .html)
        var leafFound = false
        for comp in run.presentationIntent?.components ?? [] {
            switch comp.kind {
            case .paragraph where !leafFound: (u.id, u.leaf, leafFound) = (comp.identity, .paragraph, true)
            case .header(let level) where !leafFound: (u.id, u.leaf, leafFound) = (comp.identity, .heading(level), true)
            case .codeBlock(let lang) where !leafFound: (u.id, u.leaf, leafFound) = (comp.identity, .code(lang?.isEmpty == false ? lang : nil), true)
            case .thematicBreak where !leafFound: (u.id, u.leaf, leafFound) = (comp.identity, .rule, true)
            case .tableCell(let c) where !leafFound: (u.id, u.leaf, leafFound, u.col) = (comp.identity, .cell, true, c)
            case .orderedList: u.lists.append(true)
            case .unorderedList: u.lists.append(false)
            case .listItem(let n): if u.itemID == nil { (u.itemID, u.ordinal) = (comp.identity, n) }
            case .blockQuote: u.quote = true
            case .table(let cols): (u.tableID, u.columns) = (comp.identity, cols.count)
            case .tableHeaderRow: u.headerRow = true
            case .tableRow(let r): u.row = r
            default: break
            }
        }
        if !leafFound { // 블록 HTML 은 intent 가 없다. 그 밖에 intent 가 없는 글은 문단으로
            anonymous += 1
            u.id = -anonymous
            u.leaf = inline.contains(.blockHTML) ? .html : .paragraph
        }
        if var last = units.last, last.id == u.id, u.id >= 0 {
            last.text.append(piece)
            units[units.count - 1] = last
        } else {
            u.text = piece
            units.append(u)
        }
    }

    var blocks: [MarkdownBlock] = []
    var seenItems = Set<Int>()
    var table: (id: Int, columns: Int, header: [Int: AttributedString], rows: [Int: [Int: AttributedString]])?

    func flushTable() {
        guard let t = table else { return }
        let blank = AttributedString()
        let header = (0..<t.columns).map { t.header[$0] ?? blank }
        let rows = (t.rows.keys.max() ?? 0 > 0 ? Array(1...(t.rows.keys.max() ?? 0)) : []).map { r in
            (0..<t.columns).map { t.rows[r]?[$0] ?? blank }
        }
        blocks.append(.table(header: header, rows: rows))
        table = nil
    }

    for u in units {
        if case .cell = u.leaf, let tid = u.tableID {
            if table?.id != tid {
                flushTable()
                table = (tid, u.columns, [:], [:])
            }
            if u.headerRow { table?.header[u.col] = u.text } else { table?.rows[u.row, default: [:]][u.col] = u.text }
            continue
        }
        flushTable()
        switch u.leaf {
        case .heading(let level):
            blocks.append(.heading(level: level, u.text))
        case .code(let lang):
            var s = String(u.text.characters)
            if s.hasSuffix("\n") { s.removeLast() }
            blocks.append(.code(language: lang, text: s))
        case .rule:
            blocks.append(.rule)
        case .html:
            var s = String(u.text.characters)
            while s.hasSuffix("\n") { s.removeLast() }
            blocks.append(.code(language: "html", text: s))
        case .cell, .paragraph:
            if let item = u.itemID, !seenItems.contains(item) { // 항목의 첫 문단만 글머리를 단다
                seenItems.insert(item)
                blocks.append(.listItem(ordered: u.lists.first ?? false, index: u.ordinal, depth: max(0, u.lists.count - 1), u.text))
            } else if u.itemID == nil, u.quote {
                blocks.append(.quote(u.text))
            } else {
                blocks.append(.paragraph(u.text))
            }
        }
    }
    flushTable()
    return blocks
}
