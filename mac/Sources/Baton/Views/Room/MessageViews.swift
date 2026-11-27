import SwiftUI

// MARK: 색·크기

/// 내용 폭에 맞추되 limit 를 넘지 않는다(frame(maxWidth:) 는 남는 폭을 다 차지해서 쓸 수 없다)
struct MaxWidth: Layout {
    var limit: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        subviews[0].sizeThatFits(ProposedViewSize(width: min(proposal.width ?? limit, limit), height: proposal.height))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews[0].place(at: bounds.origin, proposal: ProposedViewSize(width: bounds.width, height: bounds.height))
    }
}

private struct ChatWidthKey: EnvironmentKey { static let defaultValue: CGFloat = 760 }

extension EnvironmentValues {
    /// 채팅 영역 폭(말풍선 78%·Claude 블록 88% 상한 계산용)
    var chatWidth: CGFloat {
        get { self[ChatWidthKey.self] }
        set { self[ChatWidthKey.self] = newValue }
    }
}

// MARK: 항목

struct ChatItemView: View {
    let item: ChatItem
    let model: RoomModel

    var body: some View {
        switch item {
        case .human(let m, let continuing):
            HumanMessageView(model: model, m: m, continuing: continuing, isRequest: false)
        case .request(let m, let continuing):
            HumanMessageView(model: model, m: m, continuing: continuing, isRequest: true)
        case .claude(_, let modelName, let parts, let cards, let progress):
            ClaudeGroupView(model: model, modelName: modelName, parts: parts, cards: cards, progress: progress)
        case .notice(let m):
            Text(m.body).typo(.caption).foregroundStyle(Theme.sub)
                .lineLimit(1).truncationMode(.tail).help(m.body)
                .frame(maxWidth: .infinity, alignment: .center)
        }
    }
}

/// 사람 메시지. 내 것은 오른쪽 진녹 상자, 남의 것은 왼쪽 카드 상자 + 위에 사람별 이름 색. 같은 사람 연속이면 이름·아바타 생략(CH2)
struct HumanMessageView: View {
    let model: RoomModel
    let m: ChatMessage
    let continuing: Bool
    let isRequest: Bool
    @Environment(\.chatWidth) private var chatWidth

    private var mine: Bool { m.userId == model.me }
    private var idx: Int { Format.personIndex(m.userId ?? 0) }
    private var avatarFill: Color { mine ? Theme.mine : Theme.personText[idx] }
    private var avatarText: Color { mine ? Theme.onMine : Theme.onPerson }

    var body: some View {
        if mine { mineBody } else { otherBody }
    }

    private var time: some View { Text(Format.formatTime(m.createdAt)).typo(.caption).foregroundStyle(Theme.sub) }

    private var bubbleLimit: CGFloat { max(240, chatWidth * 0.78 - 90) }

    private var bubbleText: some View {
        Text(m.body)
            .font(Typo.body.font).lineSpacing(5)
            .foregroundStyle(mine ? Theme.onMine : Theme.text)
            .textSelection(.enabled)
            .padding(.horizontal, 14).padding(.vertical, 10)
    }

    private var avatar: some View {
        Text(Format.initial(m.userName))
            .font(Fonts.font(14, .bold)).foregroundStyle(avatarText)
            .frame(width: 32, height: 32).background(Circle().fill(avatarFill))
            .accessibilityHidden(true)
    }

    private var mineBody: some View {
        VStack(alignment: .trailing, spacing: 4) {
            HStack(alignment: .bottom, spacing: 8) {
                time
                MaxWidth(limit: bubbleLimit) {
                    bubbleText.background(RoundedRectangle(cornerRadius: Theme.radius).fill(Theme.mine))
                }
                if continuing { Color.clear.frame(width: 32, height: 1) } else { avatar }
            }
            if isRequest { RequestMeta(model: model, m: m, mine: mine).padding(.trailing, 40) }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }

    private var otherBody: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top, spacing: 8) {
                if continuing { Color.clear.frame(width: 32, height: 1) } else { avatar }
                VStack(alignment: .leading, spacing: 4) {
                    if !continuing {
                        Text(m.userName ?? "알 수 없음").typo(.uiStrong).foregroundStyle(Theme.personText[idx]).lineLimit(1)
                    }
                    HStack(alignment: .bottom, spacing: 8) {
                        MaxWidth(limit: bubbleLimit) { bubbleText.boxed() }
                        time
                    }
                }
            }
            if isRequest { RequestMeta(model: model, m: m, mine: mine).padding(.leading, 40) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

extension View {
    /// 카드 바탕 + 선 테두리 상자(남의 말·진행 표시·서브에이전트·도구 줄·diff 카드)
    func boxed() -> some View {
        background(RoundedRectangle(cornerRadius: Theme.radius).fill(Theme.card))
            .overlay(RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.line, lineWidth: 1))
    }
}

/// 요청 상태 줄: 상태 칩 · 실패 사유 · [중단] · [다시 보내기] · 승인 대기
struct RequestMeta: View {
    let model: RoomModel
    let m: ChatMessage
    let mine: Bool

    var body: some View {
        HStack(spacing: 8) {
            StatusBadge(status: m.status)
            if (m.status == "failed" || m.status == "held"), let err = m.error {
                let text = Format.failText(err)
                Text(text).typo(.ui).foregroundStyle(Theme.dangerText).lineLimit(1).truncationMode(.tail).help(text)
            }
            if ["queued", "running", "held"].contains(m.status), mine || model.isOwner {
                Button("중단") { model.cancel(m.id) }.buttonStyle(.baton(.danger, .small))
            }
            if ["failed", "held", "cancelled"].contains(m.status), mine {
                Button("다시 보내기") { model.retry(m.id) }.buttonStyle(.baton(.soft, .small))
            }
            if m.status == "running", let ap = model.approvals[m.id] {
                let text = "\(ap.userName) 님 승인 기다리는 중 · \(ToolText.label(ap.toolName))"
                Text(text).typo(.uiStrong).foregroundStyle(Theme.warnText).lineLimit(1).truncationMode(.tail).help(text)
            }
        }
    }
}

struct StatusBadge: View {
    let status: String

    private var colors: (bg: Color, fg: Color) {
        switch status {
        case "running": (Theme.accentSoft, Theme.accentText)
        case "done": (Theme.successText.opacity(0.14), Theme.successText)
        case "failed": (Theme.dangerText.opacity(0.14), Theme.dangerText)
        case "held": (Theme.warnText.opacity(0.16), Theme.warnText)
        default: (Theme.card, Theme.sub)
        }
    }

    var body: some View {
        Text(Format.statusText[status] ?? status)
            .typo(.captionStrong).foregroundStyle(colors.fg)
            .padding(.horizontal, 8).frame(height: 20)
            .background(RoundedRectangle(cornerRadius: Theme.radius).fill(colors.bg))
    }
}

// MARK: Claude 답

struct ClaudeGroupView: View {
    let model: RoomModel
    let modelName: String?
    let parts: [ClaudePart]
    let cards: [CodeResult]
    let progress: ProgressLine?
    @Environment(\.chatWidth) private var chatWidth

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !parts.isEmpty || progress != nil {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 6) {
                        Text("CLAUDE").font(Fonts.font(12, .semibold)).tracking(0.7).foregroundStyle(Theme.primary)
                        if let label = modelName.map(Format.modelLabel), !label.isEmpty {
                            Text("· \(label)").typo(.caption).foregroundStyle(Theme.sub)
                        }
                    }
                    ForEach(parts, id: \.id) { part in ClaudePartView(model: model, part: part) }
                    if let progress { ProgressLineView(line: progress) }
                }
                .padding(.leading, 14)
                .overlay(alignment: .leading) { Rectangle().fill(Theme.primary).frame(width: 2) }
            }
            ForEach(cards) { card in CodeCardView(model: model, card: card) }
        }
        .frame(maxWidth: chatWidth * 0.88, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Claude 답 안의 조각 하나(서브에이전트 카드 안에서도 같은 걸 쓴다)
struct ClaudePartView: View {
    let model: RoomModel
    let part: ClaudePart

    var body: some View {
        switch part {
        case .text(_, let blocks): MarkdownView(blocks: blocks)
        case .tool(let key, _, let name, let input): ToolLineView(model: model, key: key, name: name, input: input)
        case .thinking(let key, let text, let seconds): ThinkingLineView(model: model, key: key, text: text, seconds: seconds)
        case .agent(let key, let title, let running, let parts): AgentCardView(model: model, key: key, title: title, running: running, parts: parts)
        case .error(let text): Text(text).typo(.ui).foregroundStyle(Theme.dangerText)
        case .notice(_, let text, let warn):
            HStack(spacing: 6) {
                Image(systemName: warn ? "exclamationmark.triangle" : "arrow.triangle.branch").font(.system(size: 12, weight: .semibold))
                Text(text).lineLimit(2).truncationMode(.middle).help(text)
            }
            .typo(.caption).foregroundStyle(warn ? Theme.warnText : Theme.sub)
        }
    }
}

/// 지금 단계 한 줄 + 요청 시각부터 지난 시간(1초마다 갱신). 길이가 넘치면 값만 말줄임
struct ProgressLineView: View {
    let line: ProgressLine

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { ctx in
            let sec = Int((ctx.date.timeIntervalSince1970 * 1000 - line.since) / 1000)
            let tip = line.detail.isEmpty ? line.label : "\(line.label) · \(line.detail)"
            HStack(spacing: 6) {
                Text(line.detail.isEmpty ? line.label : "\(line.label) ·").fixedSize()
                if !line.detail.isEmpty { Text(line.detail).lineLimit(1).truncationMode(.tail) }
                Text((line.detail.isEmpty && line.label.hasSuffix("…") ? "" : "· ") + RunProgress.elapsedText(sec)).fixedSize()
            }
            .typo(.ui).foregroundStyle(Theme.sub)
            .padding(.horizontal, 12).padding(.vertical, 8)
            .boxed()
            .help(tip)
        }
    }
}

/// 생각 블록 한 줄. 내용이 있으면 눌러서 펼친다
struct ThinkingLineView: View {
    let model: RoomModel
    let key: String
    let text: String
    let seconds: Int?

    var body: some View {
        let title = "생각함" + (seconds.map { " · \(RunProgress.elapsedText($0))" } ?? "")
        let open = model.openTools.contains(key)
        VStack(alignment: .leading, spacing: 4) {
            if text.isEmpty {
                Text(title).padding(.horizontal, 12)
            } else {
                Button {
                    if open { model.openTools.remove(key) } else { model.openTools.insert(key) }
                } label: {
                    HStack(spacing: 6) {
                        Text(open ? "▾" : "▸").frame(width: 10)
                        Text(title)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 12).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if open {
                    Text(text).lineSpacing(3).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 12)
                }
            }
        }
        .typo(.ui).foregroundStyle(Theme.sub)
    }
}

/// 서브에이전트 카드. 작업 중이면 펼침, 끝났으면 접힘이 기본이고 머리를 누르면 뒤집힌다
struct AgentCardView: View {
    let model: RoomModel
    let key: String
    let title: String
    let running: Bool
    let parts: [ClaudePart]

    var body: some View {
        let open = running != model.toggledAgents.contains(key)
        let head = title.isEmpty ? "서브에이전트" : "서브에이전트 · \(title)"
        VStack(alignment: .leading, spacing: 8) {
            Button {
                if model.toggledAgents.contains(key) { model.toggledAgents.remove(key) } else { model.toggledAgents.insert(key) }
            } label: {
                HStack(spacing: 6) {
                    Text(open ? "▾" : "▸").frame(width: 10)
                    Text(head).lineLimit(1).truncationMode(.tail)
                    Spacer(minLength: 8)
                    Text(running ? "작업 중" : "끝남").typo(.caption).foregroundStyle(running ? Theme.accentText : Theme.sub).fixedSize()
                }
                .typo(.ui).foregroundStyle(Theme.sub)
                .padding(.horizontal, 12).padding(.vertical, 8)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .boxed()
            .help(head)
            if open && !parts.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(parts, id: \.id) { part in ClaudePartView(model: model, part: part) }
                }
                .padding(.leading, 12)
                .overlay(alignment: .leading) { Rectangle().fill(Theme.line).frame(width: 2) }
                .padding(.leading, 12)
            }
        }
    }
}

/// 도구 호출 한 줄(누르면 입력 전체). 긴 값은 한 줄 말줄임 + 툴팁(CH5·CH6)
struct ToolLineView: View {
    let model: RoomModel
    let key: String
    let name: String
    let input: JSON

    var body: some View {
        let s = ToolText.summary(name: name, input: input)
        let open = model.openTools.contains(key)
        VStack(alignment: .leading, spacing: 0) {
            Button {
                if open { model.openTools.remove(key) } else { model.openTools.insert(key) }
            } label: {
                HStack(spacing: 6) {
                    Text(open ? "▾" : "▸").frame(width: 10)
                    Text(s.detail.isEmpty ? s.label : "\(s.label) ·").fixedSize()
                    if !s.detail.isEmpty {
                        Text(s.detail).lineLimit(1).truncationMode(name == "Bash" ? .tail : .middle)
                    }
                    Spacer(minLength: 0)
                }
                .typo(.ui).foregroundStyle(Theme.sub)
                .padding(.horizontal, 12).padding(.vertical, 8)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(s.detail.isEmpty ? s.label : "\(s.label) · \(s.detail)")
            if open {
                ScrollView {
                    Text(Self.pretty(input))
                        .font(.system(size: 12, design: .monospaced)).foregroundStyle(Theme.sub)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                        .padding(.horizontal, 12).padding(.bottom, 12)
                }
                .frame(maxHeight: 240)
            }
        }
        .boxed()
    }

    private static func pretty(_ j: JSON) -> String {
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return (try? enc.encode(j)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
    }
}

// MARK: 바뀐 코드 카드

struct CodeCardView: View {
    let model: RoomModel
    let card: CodeResult

    private var head: String {
        "커밋 전 변경 · \(card.name) · 파일 \(card.files.count)개" + (card.ahead > 0 ? " · 올리지 않은 커밋 \(card.ahead)개" : "")
    }

    var body: some View {
        let open = model.openDiffs.contains(card.id)
        VStack(alignment: .leading, spacing: 8) {
            Text(head).typo(.uiStrong).foregroundStyle(Theme.text).lineLimit(1).truncationMode(.tail).help(head)
            if !card.files.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(card.files.enumerated()), id: \.offset) { _, f in fileRow(f) }
                }
            }
            if !card.diff.isEmpty {
                Button(open ? "diff 접기" : "diff 보기") {
                    if open { model.openDiffs.remove(card.id) } else { model.openDiffs.insert(card.id) }
                }
                .buttonStyle(TextButtonStyle(color: Theme.accentText))
                .padding(.leading, -6)
                if open {
                    DiffView(diff: card.diff)
                    if card.truncated { Text("앞부분만 보여요").typo(.caption).foregroundStyle(Theme.sub) }
                }
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .boxed()
        .id("card:\(card.id)")
    }

    private func fileRow(_ f: CodeResult.File) -> some View {
        let (glyph, color, tip): (String, Color, String) = switch f.status {
        case "M": ("M", Theme.accentText, "수정")
        case "??", "A": (f.status == "??" ? "?" : "A", Theme.successText, "새 파일")
        case "D": ("D", Theme.dangerText, "삭제")
        default: (f.status, Theme.sub, f.status)
        }
        return HStack(spacing: 8) {
            Text(glyph).foregroundStyle(color).frame(width: 24, alignment: .leading).help(tip)
            Text(ToolText.shortPath(f.path)).lineLimit(1).truncationMode(.middle).foregroundStyle(Theme.text).help(f.path)
        }
        .font(.system(size: 12, design: .monospaced))
    }
}

/// diff: 12/18 고정폭, 줄마다 색, 가로·세로 스크롤(최대 높이 320)
struct DiffView: View {
    let diff: String

    private var lines: [String] {
        var l = diff.components(separatedBy: "\n")
        if l.last == "" { l.removeLast() }
        return l
    }

    private func fill(_ l: String) -> Color {
        if l.hasPrefix("+++") || l.hasPrefix("---") || l.hasPrefix("diff ") || l.hasPrefix("index ") || l.hasPrefix("@@") { return .clear }
        if l.hasPrefix("+") { return Theme.diffAdd }
        if l.hasPrefix("-") { return Theme.diffDel }
        return .clear
    }

    private func color(_ l: String) -> Color {
        l.hasPrefix("+++") || l.hasPrefix("---") || l.hasPrefix("diff ") || l.hasPrefix("index ") || l.hasPrefix("@@") ? Theme.sub : Theme.text
    }

    var body: some View {
        ScrollView([.horizontal, .vertical]) {
            ZStack(alignment: .topLeading) {
                Color.clear.frame(height: 0).containerRelativeFrame(.horizontal) // 가로는 스크롤 영역 폭 이상으로
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(lines.enumerated()), id: \.offset) { _, l in
                        Text(l.isEmpty ? " " : l)
                            .font(.system(size: 12, design: .monospaced)).foregroundStyle(color(l))
                            .lineLimit(1).fixedSize(horizontal: true, vertical: false)
                            .padding(.horizontal, 12)
                            .frame(maxWidth: .infinity, minHeight: 18, alignment: .leading)
                            .background(fill(l))
                    }
                }
                .padding(.vertical, 8)
            }
        }
        .frame(maxHeight: 320)
        .background(RoundedRectangle(cornerRadius: Theme.radius).fill(Theme.bg))
        .clipShape(RoundedRectangle(cornerRadius: Theme.radius))
    }
}
