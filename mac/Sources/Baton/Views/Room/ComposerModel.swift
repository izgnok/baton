import Foundation
import Observation

/// 입력창 상태: 글·보낼 대상·자동완성. 글의 진짜 주인은 입력칸(NSTextView)이고,
/// 모델이 글을 바꿀 때(고르기·보낸 뒤 비우기·캡처)만 pushSerial 을 올려 입력칸이 갈아 끼운다.
@MainActor @Observable
final class ComposerModel {
    enum Mode: String { case claude, human }

    static let efforts = ["low", "medium", "high", "xhigh", "max"]

    @ObservationIgnored private unowned let room: RoomModel
    @ObservationIgnored private unowned let app: AppModel

    private(set) var text = ""
    private(set) var caret = 0
    /// 입력칸 높이(글에 맞춰 입력칸이 잰다, 36~160). SwiftUI 가 이 값으로 칸 높이를 다시 잡는다
    var fieldHeight: CGFloat = 36
    /// 밖에서 글을 바꿨을 때 올라간다
    private(set) var pushSerial = 0
    /// 입력칸에 포커스를 돌려줄 때 올라간다
    private(set) var focusSerial = 0
    var focused = false
    private(set) var mode: Mode
    private(set) var items: [Complete.Suggestion] = []
    var selected = 0
    private(set) var note: String?
    private(set) var sending = false

    @ObservationIgnored private var trigger: Complete.Trigger?
    @ObservationIgnored private var seq = 0
    @ObservationIgnored private var skillsTask: Task<[Complete.Skill], Never>?
    @ObservationIgnored private var sharedPaths: [String]?
    @ObservationIgnored private var repoTask: Task<Void, Never>?

    init(room: RoomModel, app: AppModel) {
        self.room = room
        self.app = app
        mode = UserDefaults.standard.string(forKey: "rooms.mode.\(room.roomId)") == "human" ? .human : .claude
    }

    var isOpen: Bool { !items.isEmpty }

    /// 입력칸 안내 글(점검표 4장)
    var placeholder: String {
        mode == .claude ? "Claude에게 보내기 (/ 명령, @ 파일)" : "사람끼리 대화 (Claude는 못 봐요)"
    }

    // MARK: 대상·모델

    func setMode(_ next: Mode) {
        mode = next
        UserDefaults.standard.set(next.rawValue, forKey: "rooms.mode.\(room.roomId)")
        focusSerial += 1
    }

    // MARK: 글 바뀜

    /// 입력칸에서 글·캐럿이 바뀌었다(UTF-16 위치)
    func edited(text newText: String, caret newCaret: Int) {
        if newText == text && newCaret == caret { return }
        if newText != text { note = nil }
        text = newText
        caret = newCaret
        update()
    }

    /// 밖에서 글을 정한다(캡처). 캐럿은 끝
    func setText(_ value: String) {
        text = value
        caret = value.utf16.count
        pushSerial += 1
        note = nil
        update()
    }

    func invalidateShared() { sharedPaths = nil }

    func blurred() {
        Task {
            try? await Task.sleep(for: .milliseconds(150)) // 목록을 눌러 고르는 동안은 닫지 않는다
            if !focused { close() }
        }
    }

    // MARK: 자동완성

    func close() {
        items = []
        trigger = nil
        seq += 1
        repoTask?.cancel()
    }

    private func update() {
        guard let t = Complete.detectTrigger(text, caret: caret) else { return close() }
        trigger = t
        seq += 1
        let mine = seq
        selected = 0
        repoTask?.cancel()
        switch t.kind {
        case .slash:
            Task {
                let skills = await loadSkills()
                guard mine == seq else { return }
                show(Complete.slashSuggestions(skills: skills, query: t.query))
            }
        case .mention:
            // 멤버·공유 파일은 바로, 레포 파일은 입력을 멈춘 뒤 찾는다
            let members = Complete.memberSuggestions(names: room.memberNames, query: t.query)
            Task {
                let shared = Complete.sharedSuggestions(paths: await loadShared(), query: t.query)
                guard mine == seq else { return }
                show(Complete.mergeMentionItems(members: members, shared: shared))
                guard !t.query.isEmpty else { return }
                repoTask = Task {
                    try? await Task.sleep(for: .milliseconds(200))
                    guard !Task.isCancelled, mine == seq else { return }
                    let files = await searchRepoFiles(t.query)
                    guard !Task.isCancelled, mine == seq else { return }
                    show(Complete.mergeMentionItems(members: members, shared: shared, repoFiles: files))
                }
            }
        }
    }

    private func show(_ list: [Complete.Suggestion]) {
        items = list
        selected = min(selected, max(0, list.count - 1))
    }

    private func loadSkills() async -> [Complete.Skill] {
        if skillsTask == nil {
            skillsTask = Task {
                let j = try? await app.call("listSkills", .object(["roomId": .number(Double(room.roomId))]), toast: false)
                return (j?.array ?? []).map {
                    Complete.Skill(name: $0["name"]?.string ?? "", description: $0["description"]?.string ?? "", source: $0["source"]?.string ?? "")
                }
            }
        }
        let list = await skillsTask?.value ?? []
        if list.isEmpty { skillsTask = nil } // 못 읽었으면 다음에 다시
        return list
    }

    private func loadShared() async -> [String] {
        if let sharedPaths { return sharedPaths }
        guard let j = try? await app.call("listShared", .object(["roomId": .number(Double(room.roomId))]), toast: false) else { return [] }
        let paths = (j.array ?? []).compactMap { $0["path"]?.string }
        sharedPaths = paths
        return paths
    }

    private func searchRepoFiles(_ query: String) async -> [Complete.Suggestion] {
        let args = JSON.object(["roomId": .number(Double(room.roomId)), "query": .string(query)])
        guard let j = try? await app.call("listRepoFiles", args, toast: false) else { return [] }
        return (j.array ?? []).map {
            Complete.repoSuggestion(name: $0["name"]?.string ?? "", path: $0["path"]?.string ?? "", mention: $0["mention"]?.string ?? "")
        }
    }

    func move(_ delta: Int) {
        guard !items.isEmpty else { return }
        selected = (selected + delta + items.count) % items.count
    }

    func choose(_ i: Int) {
        guard let t = trigger, items.indices.contains(i) else { return }
        let e = Complete.applyChoice(text, caret: caret, trigger: t, insert: items[i].insert)
        text = e.value
        caret = e.caret
        pushSerial += 1
        focusSerial += 1
        close()
    }

    // MARK: 보내기

    func send() {
        let typed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !sending, !typed.isEmpty else { return }
        // [Claude] 상태의 일반 글은 @claude 를 붙여 보낸다. / 로 시작하는 글은 어느 상태든 Claude 에게 간다
        let out = Complete.outgoing(typed, toClaude: mode == .claude)
        if Complete.startsWithClaude(out) && app.claude?.loggedIn != true {
            note = "Claude 로그인이 필요해요. 방 목록에서 로그인해 주세요"
            return
        }
        sending = true
        Task {
            if let sent = try? await app.call("sendMessage", .object(["roomId": .number(Double(room.roomId)), "text": .string(out)])) {
                room.didSend(sent)
                text = ""
                caret = 0
                pushSerial += 1
                close()
            }
            sending = false
            focusSerial += 1
        }
    }
}
