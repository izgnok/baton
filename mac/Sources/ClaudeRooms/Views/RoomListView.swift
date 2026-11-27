import SwiftUI

struct RoomItem: Identifiable, Equatable {
    let id: Int
    let name: String
    let createdAt: Double

    init?(_ j: JSON) {
        guard let id = j["id"]?.int else { return nil }
        self.id = id
        name = j["name"]?.string ?? ""
        createdAt = j["createdAt"]?.number ?? 0
    }
}

/// 내가 멤버가 아닌 공개 방(초대 코드 없이 참가)
struct PublicRoomItem: Identifiable, Equatable {
    let id: Int
    let name: String
    let memberCount: Int

    init?(_ j: JSON) {
        guard let id = j["id"]?.int else { return nil }
        self.id = id
        name = j["name"]?.string ?? ""
        memberCount = j["memberCount"]?.int ?? 0
    }
}

struct RoomListView: View {
    let app: AppModel
    @Local private var rooms: [RoomItem] = []
    @Local private var publicRooms: [PublicRoomItem] = []
    @Local private var joining: Int?
    @Local private var loaded = false
    @Local private var loginBusy = false
    @Local private var checking = false
    @Local private var sheet: RoomSheet?

    enum RoomSheet: Identifiable {
        case create, join
        var id: Int { self == .create ? 0 : 1 }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                Spacer()
                if app.serverHost.state == .running {
                    Text("서버 실행 중").typo(.caption).foregroundStyle(Theme.successText).padding(.trailing, 6)
                }
                Button(checking ? "확인 중…" : "업데이트 확인") {
                    checking = true
                    Task {
                        await app.checkUpdate()
                        checking = false
                    }
                }
                .buttonStyle(.text)
                .disabled(checking)
                Button("로그아웃") { Task { await app.logout() } }.buttonStyle(.text)
            }
            .padding(.horizontal, 20)
            .padding(.top, 12)

            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 8) {
                        Text("채팅방").typo(.title).foregroundStyle(Theme.text)
                        Spacer()
                        Button("방 만들기") { sheet = .create }.buttonStyle(.rooms(.primary, .regular))
                        Button("초대 코드로 참가") { sheet = .join }.buttonStyle(.rooms(.secondary, .regular))
                    }
                    .padding(.top, 8)
                    .padding(.bottom, 16)

                    if let c = app.claude { claudeCard(c).padding(.bottom, 24) }
                    roomList
                    if !publicRooms.isEmpty { publicList.padding(.top, 32) }
                }
                .frame(maxWidth: 520)
                .padding(.horizontal, 24)
                .frame(maxWidth: .infinity)
            }
        }
        .sheet(item: $sheet) { which in
            switch which {
            case .create:
                FormSheet(
                    title: "방 이름을 정해 주세요", submitLabel: "방 만들기",
                    fields: [.init(id: "name", label: "방 이름", placeholder: "예: 결제 개선")],
                    onSubmit: { v in
                        let room = try await app.call("createRoom", .object(["name": .string(v["name"] ?? "")]), toast: false)
                        app.toast("방을 만들었어요")
                        if let id = room["id"]?.int { app.openRoom(id) }
                    })
            case .join:
                FormSheet(
                    title: "초대 코드를 입력해 주세요", submitLabel: "참가하기",
                    fields: [.init(id: "code", label: "초대 코드", placeholder: "ABC123")],
                    errors: ["NOT_FOUND": "초대 코드를 찾을 수 없어요"],
                    onSubmit: { v in
                        let room = try await app.call("joinRoom", .object(["inviteCode": .string(v["code"] ?? "")]), toast: false)
                        app.toast("방에 참가했어요")
                        if let id = room["id"]?.int { app.openRoom(id) }
                    })
            }
        }
        .task(id: app.roomsVersion) { await load() }
        .task { await app.refreshClaude() }
    }

    // MARK: Claude 카드

    @ViewBuilder
    private func claudeCard(_ c: ClaudeStatus) -> some View {
        HStack(alignment: .center, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                if c.loggedIn {
                    // 계정·요금제는 화면 이름으로(RL2)
                    Text(["Claude", c.orgName, c.subscriptionType.map(Self.planName)].compactMap { $0 }.joined(separator: " · "))
                        .typo(.heading).foregroundStyle(Theme.text).lineLimit(1).truncationMode(.tail)
                    if let email = c.email {
                        Text(email).typo(.ui).foregroundStyle(Theme.sub).lineLimit(1).truncationMode(.middle)
                    }
                    UsageBars(usage: app.usage).padding(.top, 8)
                } else {
                    Text("Claude 로그인이 필요해요").typo(.heading).foregroundStyle(Theme.text)
                    Text("사람끼리 채팅만 할 수 있어요").typo(.ui).foregroundStyle(Theme.sub)
                }
            }
            Spacer(minLength: 0)
            if !c.loggedIn {
                Button(loginBusy ? "로그인 중…" : "Claude 로그인") {
                    loginBusy = true
                    Task {
                        _ = try? await app.call("claudeLogin", timeout: nil)
                        loginBusy = false
                        await app.refreshClaude()
                    }
                }
                .buttonStyle(.rooms(.primary, .small))
                .disabled(loginBusy)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(Theme.accentSoft)
    }

    static func planName(_ t: String) -> String {
        switch t.lowercased() {
        case "team": "Team"
        case "pro": "Pro"
        case "max": "Max"
        case "enterprise": "Enterprise"
        case "free": "Free"
        default: t.prefix(1).uppercased() + t.dropFirst()
        }
    }

    // MARK: 방 목록

    @ViewBuilder
    private var roomList: some View {
        if loaded && rooms.isEmpty {
            VStack(spacing: 4) {
                Text("아직 참여 중인 방이 없어요")
                Text("방을 만들거나 초대 코드로 참가해 보세요")
            }
            .typo(.ui).foregroundStyle(Theme.sub)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 64)
        } else {
            VStack(spacing: 12) {
                ForEach(rooms) { r in
                    Button { app.openRoom(r.id) } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(r.name).typo(.heading).foregroundStyle(Theme.text).lineLimit(1).truncationMode(.tail).help(r.name)
                            Text(Format.createdText(r.createdAt)).typo(.caption).foregroundStyle(Theme.sub)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .card()
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    // MARK: 참가할 수 있는 방

    private var publicList: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("참가할 수 있는 방").typo(.heading).foregroundStyle(Theme.text)
            ForEach(publicRooms) { r in
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(r.name).typo(.heading).foregroundStyle(Theme.text).lineLimit(1).truncationMode(.tail).help(r.name)
                        Text(PanelText.memberCountText(r.memberCount)).typo(.caption).foregroundStyle(Theme.sub)
                    }
                    Spacer(minLength: 8)
                    Button("참가") { Task { await join(r) } }
                        .buttonStyle(.rooms(.onCard, .small))
                        .disabled(joining != nil)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .card()
            }
        }
    }

    private func join(_ r: PublicRoomItem) async {
        joining = r.id
        defer { joining = nil }
        do {
            let room = try await app.call("joinPublicRoom", .object(["roomId": .number(Double(r.id))]), toast: false)
            app.toast("방에 참가했어요")
            if let id = room["id"]?.int { app.openRoom(id) }
        } catch {
            // 그 사이 비공개로 바뀌었거나 사라진 방이면 목록을 다시 읽는다
            if case .remote(let code)? = error as? CoreError, code == "FORBIDDEN" || code == "NOT_FOUND" {
                app.toast("이 방은 이제 참가할 수 없어요")
            } else {
                app.toast(AppModel.message(error))
            }
            await load()
        }
    }

    private func load() async {
        if let j = try? await app.call("listRooms") {
            publicRooms = (j["publicRooms"]?.array ?? []).compactMap(PublicRoomItem.init)
            rooms = (j["rooms"]?.array ?? []).compactMap(RoomItem.init)
            for r in rooms { app.roomNames[r.id] = r.name }
        }
        loaded = true
        app.roomsLoaded = true
    }
}
