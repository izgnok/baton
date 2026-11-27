import Foundation
import Observation

// MARK: 서버 메시지 → 화면 값

/// Claude 답 안의 한 조각
enum ClaudePart: Equatable {
    case text(key: String, blocks: [MarkdownBlock])
    case tool(key: String, name: String, input: JSON)
    case error(String)
    case note(String)

    var id: String {
        switch self {
        case .text(let k, _), .tool(let k, _, _): k
        case .error(let s): "error:\(s)"
        case .note(let s): "note:\(s)"
        }
    }
}

/// 방 작업 폴더의 바뀐 코드 카드(rooms_code_changes)
struct CodeResult: Equatable, Identifiable {
    struct File: Equatable { var status: String; var path: String }
    var id: String
    var name: String
    var files: [File]
    var diff: String
    var truncated: Bool
    var ahead: Int
}

/// claude_event 한 건을 해석한 결과
struct ParsedEvent: Equatable {
    var model: String?
    var parts: [ClaudePart] = []
    var cards: [CodeResult] = []

    init?(id: Int, body: String) {
        guard let ev = try? JSONDecoder().decode(JSON.self, from: Data(body.utf8)) else { return nil }
        switch ev["type"]?.string {
        case "assistant":
            model = ev["message"]?["model"]?.string
            let content = ev["message"]?["content"]
            if let s = content?.string {
                parts.append(.text(key: "\(id):0", blocks: markdownBlocks(s)))
            } else {
                for (i, c) in (content?.array ?? []).enumerated() {
                    switch c["type"]?.string {
                    case "text": parts.append(.text(key: "\(id):\(i)", blocks: markdownBlocks(c["text"]?.string ?? "")))
                    case "tool_use": parts.append(.tool(key: "\(id):\(i)", name: c["name"]?.string ?? "", input: c["input"] ?? .null))
                    default: break
                    }
                }
            }
        case "rooms_code_changes":
            for r in ev["results"]?.array ?? [] {
                let files = (r["files"]?.array ?? []).map { CodeResult.File(status: $0["status"]?.string ?? "", path: $0["path"]?.string ?? "") }
                cards.append(CodeResult(
                    id: "\(id):\(r["repoId"]?.int ?? 0)", name: r["name"]?.string ?? "", files: files,
                    diff: r["diff"]?.string ?? "", truncated: r["truncated"]?.bool ?? false, ahead: r["ahead"]?.int ?? 0))
            }
        case "result":
            if ev["is_error"]?.bool == true {
                let text = ev["result"]?.string ?? ""
                parts.append(.error(text.isEmpty ? "Claude 실행 중 오류가 났어요" : text))
            }
        default:
            return nil
        }
    }
}

struct ChatMessage: Identifiable, Equatable {
    let id: Int
    let userId: Int?
    let userName: String?
    let kind: String
    let body: String
    let status: String
    let requestId: Int?
    let error: String?
    let createdAt: Double
    /// claude_event 만. 마크다운 해석을 한 번만 하려고 미리 해 둔다
    let event: ParsedEvent?

    init?(_ j: JSON) {
        guard let id = j["id"]?.int else { return nil }
        self.id = id
        userId = j["userId"]?.int
        userName = j["userName"]?.string
        kind = j["kind"]?.string ?? ""
        body = j["body"]?.string ?? ""
        status = j["status"]?.string ?? ""
        requestId = j["requestId"]?.int
        error = j["error"]?.string
        createdAt = j["createdAt"]?.number ?? 0
        event = kind == "claude_event" ? ParsedEvent(id: id, body: body) : nil
    }
}

/// 채팅에 그릴 한 덩어리
enum ChatItem: Identifiable, Equatable {
    case human(ChatMessage, continuing: Bool)
    case request(ChatMessage, continuing: Bool)
    case claude(requestId: Int, model: String?, parts: [ClaudePart], cards: [CodeResult])

    var id: String {
        switch self {
        case .human(let m, _): "m\(m.id)"
        case .request(let m, _): "r\(m.id)"
        case .claude(let rid, _, _, _): "c\(rid)"
        }
    }
}

struct ScrollRequest: Equatable {
    enum Kind { case top, codeCard }
    var kind: Kind
    var serial: Int
}

// MARK: 방 화면 상태

@MainActor @Observable
final class RoomModel {
    let roomId: Int
    @ObservationIgnored private unowned let app: AppModel

    var state: JSON?
    var messages: [ChatMessage] = []
    var memberStatus: [Int: MemberStatus] = [:]
    var myModel = (model: "", effort: "")
    var tab: String
    var loaded = false
    private(set) var items: [ChatItem] = []
    /// items 가 바뀔 때마다 올라간다(채팅이 맨 아래로 갈지 정한다)
    private(set) var version = 0
    var stick = false
    var openTools: Set<String> = []
    var openDiffs: Set<String> = []
    var scrollRequest: ScrollRequest?

    @ObservationIgnored private var loading = false
    @ObservationIgnored private var buffer: [CoreEvent] = []
    @ObservationIgnored private var scrollSerial = 0

    init(roomId: Int, app: AppModel, tab: String = "repos") {
        self.roomId = roomId
        self.app = app
        self.tab = tab
    }

    // MARK: 파생 값

    var me: Int? { app.user?["id"]?.int }
    var roomName: String { state?["room"]?["name"]?.string ?? app.roomNames[roomId] ?? "" }
    var memberCount: Int { state?["members"]?.array?.count ?? 0 }
    var isOwner: Bool {
        state?["members"]?.array?.contains { $0["userId"]?.int == me && $0["isOwner"]?.bool == true } ?? false
    }
    /// 승인 대기는 방이 열리기 전에 온 알림도 놓치지 않게 AppModel 이 받아 둔다
    var approvals: [Int: ApprovalWait] { app.roomApprovals[roomId] ?? [:] }
    /// 코드 카드가 들어 있는 첫 Claude 항목의 id
    var firstCardItemID: String? {
        items.first { if case .claude(_, _, _, let cards) = $0 { !cards.isEmpty } else { false } }?.id
    }
    var cardKeys: [String] {
        items.flatMap { item -> [String] in
            if case .claude(_, _, _, let cards) = item { cards.map(\.id) } else { [] }
        }
    }

    // MARK: 불러오기

    func start() async {
        _ = app.takeRoomEvents(roomId) // 지금 읽는 서버 상태보다 오래된 알림은 버린다
        await load()
    }

    func load() async {
        guard !loading else { return }
        loading = true
        buffer = []
        defer { loading = false }
        guard let data = try? await app.call("openRoom", .object(["roomId": .number(Double(roomId))])) else {
            app.screen = .rooms
            return
        }
        messages = (data["messages"]?.array ?? []).compactMap(ChatMessage.init).sorted { $0.id < $1.id }
        state = data["state"]
        memberStatus = [:]
        if case .object(let o)? = data["memberStatus"] {
            for (k, v) in o { if let id = Int(k) { memberStatus[id] = Self.memberStatus(v) } }
        }
        myModel = (data["myModel"]?["model"]?.string ?? "", data["myModel"]?["effort"]?.string ?? "")
        loaded = true
        // 읽는 동안 도착한 알림을 순서대로 반영(이미 더 새로운 상태로 읽혔으면 되돌리지 않는다)
        let pending = buffer
        buffer = []
        loading = false
        for e in pending { apply(e, buffered: true) }
        rebuild()
        stick = true
        if app.claude == nil { Task { await app.refreshClaude() } }
    }

    // MARK: 알림

    /// 방 알림을 받는다. 읽는 중이면 모아 두었다가 읽기가 끝나면 반영
    func ingest(_ events: [CoreEvent]) {
        guard !events.isEmpty else { return }
        if loading { buffer.append(contentsOf: events); return }
        for e in events { apply(e, buffered: false) }
        rebuild()
    }

    func apply(_ e: CoreEvent, buffered: Bool = false) {
        let p = e.payload
        switch p["type"]?.string {
        case "message.new", "message.update":
            guard let json = p["message"], let m = ChatMessage(json), json["roomId"]?.int == roomId else { return }
            if buffered, let old = messages.first(where: { $0.id == m.id }), Self.rank(m.status) < Self.rank(old.status) { return }
            upsert(m)
        case "room.state":
            if p["state"]?["room"]?["id"]?.int == roomId { state = p["state"] }
        case "room.delete":
            if p["roomId"]?.int == roomId {
                app.toast("방이 삭제됐어요")
                app.screen = .rooms
            }
        case "member.status":
            if p["roomId"]?.int == roomId, let uid = p["userId"]?.int { memberStatus[uid] = Self.memberStatus(p["status"]) }
        default:
            break // local.repos·shared.changed·local.sharedConflict 는 오른쪽 패널(다음 단계)에서
        }
        if !buffered { rebuild() }
    }

    private static func rank(_ status: String) -> Int {
        switch status {
        case "queued": 0
        case "running": 1
        default: 2
        }
    }

    private static func memberStatus(_ j: JSON?) -> MemberStatus {
        MemberStatus(
            repos: j?["repos"]?.array?.compactMap(\.string) ?? [],
            readDirs: j?["readDirs"]?.array?.compactMap(\.string) ?? [],
            claude: j?["claude"]?.bool ?? false)
    }

    private func upsert(_ m: ChatMessage) {
        if let i = messages.firstIndex(where: { $0.id == m.id }) { messages[i] = m }
        else { messages.append(m); messages.sort { $0.id < $1.id } }
    }

    // MARK: 요청 중단·다시 보내기

    func cancel(_ requestId: Int) {
        Task { _ = try? await app.call("cancelRequest", .object(["roomId": .number(Double(roomId)), "requestId": .number(Double(requestId))])) }
    }

    func retry(_ requestId: Int) {
        Task { _ = try? await app.call("retry", .object(["roomId": .number(Double(roomId)), "requestId": .number(Double(requestId))])) }
    }

    // MARK: 캡처가 쓰는 화면 조작

    func setAllDiffs(open: Bool) {
        // 코드 카드 diff 는 key 가 카드 id 다
        openDiffs = open ? Set(cardKeys) : []
    }

    func scroll(_ kind: ScrollRequest.Kind) {
        scrollSerial += 1
        scrollRequest = ScrollRequest(kind: kind, serial: scrollSerial)
    }

    // MARK: 채팅 항목 만들기(room.js renderMessages 와 같은 순서)

    private func rebuild() {
        var events: [Int: [ParsedEvent]] = [:]
        for m in messages where m.kind == "claude_event" {
            if let rid = m.requestId, let ev = m.event { events[rid, default: []].append(ev) }
        }
        var out: [ChatItem] = []
        var lastHuman: Int?
        for m in messages {
            switch m.kind {
            case "chat":
                out.append(.human(m, continuing: m.userId != nil && m.userId == lastHuman))
                lastHuman = m.userId
            case "claude_request":
                out.append(.request(m, continuing: m.userId != nil && m.userId == lastHuman))
                lastHuman = m.userId
                if let block = claudeItem(m, events[m.id] ?? []) { out.append(block); lastHuman = nil }
            default:
                break
            }
        }
        items = out
        version += 1
    }

    private func claudeItem(_ req: ChatMessage, _ events: [ParsedEvent]) -> ChatItem? {
        var parts = events.flatMap(\.parts)
        let cards = events.flatMap(\.cards)
        let model = events.compactMap(\.model).first
        if parts.isEmpty && req.status == "running" { parts.append(.note("작업하는 중이에요…")) }
        if parts.isEmpty && cards.isEmpty { return nil }
        return .claude(requestId: req.id, model: model, parts: parts, cards: cards)
    }
}
