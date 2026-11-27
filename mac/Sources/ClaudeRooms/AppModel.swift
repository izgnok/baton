import AppKit
import Foundation
import Observation

enum Screen: Equatable {
    case starting
    case needNode
    case login(serverUrl: String)
    case rooms
    case room(id: Int, tab: String, preview: String?)
}

struct ClaudeStatus: Equatable {
    var loggedIn = false
    var email: String?
    var orgName: String?
    var subscriptionType: String?

    init(_ j: JSON) {
        loggedIn = j["loggedIn"]?.bool ?? false
        email = j["email"]?.string
        orgName = j["orgName"]?.string
        subscriptionType = j["subscriptionType"]?.string
    }
}

struct UsageState: Equatable {
    var fiveHour: UsageWindow?
    var sevenDay: UsageWindow?
    var updatedAt: Double?

    init?(_ j: JSON?) {
        guard let j, case .object = j else { return nil }
        fiveHour = UsageWindow(j["fiveHour"])
        sevenDay = UsageWindow(j["sevenDay"])
        updatedAt = j["updatedAt"]?.number
    }
}

struct UpdateState: Equatable {
    var count = 0
    var subjects: [String] = []
    var serverMismatch = false

    init() {}

    init(_ j: JSON?) {
        count = j?["count"]?.int ?? 0
        subjects = j?["subjects"]?.array?.compactMap(\.string) ?? []
        serverMismatch = j?["serverMismatch"]?.bool ?? false
    }
}

/// 승인 기다리는 중인 요청(run.approval)
struct ApprovalWait: Equatable {
    var userName: String
    var toolName: String
}

extension JSON {
    var number: Double? { if case .number(let v) = self { v } else { nil } }
}

@MainActor @Observable
final class AppModel {
    var screen: Screen = .starting
    var user: JSON?
    var claude: ClaudeStatus?
    var usage: UsageState?
    var update = UpdateState()
    var connected = true
    var coreDown = false
    /// 코어를 띄우지 못했거나 계속 죽을 때 띠에 보일 문구
    var coreMessage: String?
    var loginNotice: String?
    var toastText: String?
    /// 방 목록을 다시 읽어야 할 때 올라간다(room.state·room.delete 알림)
    var roomsVersion = 0
    var roomNames: [Int: String] = [:]
    /// 방별 알림 보관. 방 화면(RoomModel)이 만들어지면 넘긴다
    var roomEvents: [Int: [CoreEvent]] = [:]
    /// 답을 기다리는 승인 질문(맨 앞이 지금 뜬 시트)
    private(set) var approvals: [ApprovalRequest] = []
    /// 업데이트 적용 중(띠·시트 버튼이 함께 쓴다)
    var updating = false
    /// 지금 열린 시트(승인 창 제외). 시트가 trackSheet 로 알려 온다
    private(set) var activeSheet: SheetKind = .none
    /// [자세히] 시트 열림
    var showUpdateDetail = false
    /// 입력·확인 시트가 열려 있어 승인 창이 기다리는 중(띠가 알린다)
    var approvalBlocked: Bool {
        !approvals.isEmpty && approvalPresenter.window == nil && SheetPolicy.onApproval(open: activeSheet) == .waitWithBanner
    }
    /// 방별 승인 대기(방 화면이 열리기 전에 온 알림도 놓치지 않는다). roomId → requestId → 대기 정보
    var roomApprovals: [Int: [Int: ApprovalWait]] = [:]
    /// 방 목록 첫 읽기가 끝났는지(캡처가 기다린다)
    var roomsLoaded = false
    var claudeLoaded = false
    /// 설정의 [이 맥에서 서버 실행] 스위치(코어의 config.hostServer)
    var hostServerOn = false
    let serverHost = ServerHost(home: AppModel.homeDir)

    @ObservationIgnored private var client: CoreClient?
    @ObservationIgnored private var restart = RestartPolicy()
    @ObservationIgnored private var started = false
    @ObservationIgnored private var stopping = false
    @ObservationIgnored private var toastSeq = 0
    @ObservationIgnored private var nodePath: String?
    @ObservationIgnored private var loginPath: String?
    @ObservationIgnored private var capture: CaptureDriver?
    @ObservationIgnored private var hostAutoStarted = false
    @ObservationIgnored private var signalSources: [DispatchSourceSignal] = []
    @ObservationIgnored let approvalPresenter = ApprovalPresenter()
    /// 지금 열린 방 화면(캡처가 화면 조작을 넘긴다)
    @ObservationIgnored weak var currentRoom: RoomModel?

    static let defaultHome = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".claude-rooms")

    static var homeDir: URL {
        ProcessInfo.processInfo.environment["ROOMS_HOME"].map { URL(fileURLWithPath: $0) } ?? defaultHome
    }

    static var logPath: String { "~/.claude-rooms/core.log" }

    /// 앱이 쓰는 소스 폴더. 환경 변수가 있으면 그것이 먼저
    static var sourceRoot: String? {
        ProcessInfo.processInfo.environment["ROOMS_SOURCE"] ?? Bundle.main.object(forInfoDictionaryKey: "RoomsSource") as? String
    }

    init() {
        if let dir = ProcessInfo.processInfo.environment["ROOMS_SCREENSHOT"], !dir.isEmpty {
            capture = CaptureDriver(dir: URL(fileURLWithPath: dir), app: self)
        }
        serverHost.notify = { [weak self] in self?.toast($0) }
        // SIGTERM·SIGINT 로 끌 때도 정상 종료(willTerminate)를 거쳐 서버를 정리한다
        for sig in [SIGTERM, SIGINT] {
            signal(sig, SIG_IGN)
            let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            src.setEventHandler { NSApp.terminate(nil) }
            src.resume()
            signalSources.append(src)
        }
        NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.shutdown() }
        }
    }

    /// 창이 뜬 뒤 불린다(캡처 모드는 창 크기를 맞춘다)
    func windowReady() { capture?.prepareWindow() }

    // MARK: 코어 시작·재시작

    func start() async {
        guard !started else { return }
        started = true
        let found = await Task.detached { (NodeLocator.findNode(), NodeLocator.loginPATH()) }.value
        guard let node = found.0 else {
            screen = .needNode
            return
        }
        nodePath = node
        loginPath = found.1
        startCore()
    }

    /// 안내 화면의 [다시 확인]
    func retryNode() {
        started = false
        screen = .starting
        Task { await start() }
    }

    private func startCore() {
        guard let node = nodePath else { return }
        guard let source = Self.sourceRoot, FileManager.default.fileExists(atPath: "\(source)/app/main/core.js") else {
            coreMessage = "앱 소스 폴더를 찾지 못했어요"
            coreDown = true
            return
        }
        var env: [String: String] = [:]
        if let p = loginPath { env["PATH"] = p }
        for key in ["ROOMS_HOME", "ROOMS_SCREENSHOT"] {
            if let v = ProcessInfo.processInfo.environment[key] { env[key] = v }
        }
        let c = CoreClient(CoreLaunch(
            executable: URL(fileURLWithPath: node),
            arguments: ["\(source)/app/main/core.js"],
            environment: env,
            logURL: Self.homeDir.appendingPathComponent("core.log")))
        c.onExit = { [weak self] status in
            Task { @MainActor in self?.coreExited(c, status) }
        }
        do { try c.start() } catch {
            coreMessage = "코어를 시작하지 못했어요"
            coreDown = true
            return
        }
        client = c
        coreDown = false
        coreMessage = nil
        Task { for await e in c.events { handle(e) } }
        Task { await bootstrap() }
    }

    private func coreExited(_ c: CoreClient, _ status: Int32) {
        guard c === client, !stopping else { return }
        client = nil
        connected = false
        if restart.shouldRestart(at: Date()) {
            Task {
                try? await Task.sleep(for: .milliseconds(500))
                startCore()
            }
        } else {
            coreMessage = nil
            coreDown = true
        }
    }

    func shutdown() {
        stopping = true
        client?.stop()
        serverHost.stop(wait: true)
    }

    /// 설정 스위치. 저장하고 서버를 켜거나 끈다
    func setHostServer(_ on: Bool) {
        hostServerOn = on
        Task { _ = try? await call("setHostServer", .object(["on": .bool(on)])) }
        if on { startServer() } else { serverHost.stop() }
    }

    private func startServer() {
        guard capture == nil else { return } // 캡처 모드에서는 서버를 띄우지 않는다
        guard let node = nodePath else { toast("서버를 켜려면 Node.js가 필요해요"); return }
        guard let source = Self.sourceRoot, FileManager.default.fileExists(atPath: "\(source)/server/src/supervisor.js") else {
            toast("서버 소스 폴더를 찾지 못했어요")
            return
        }
        serverHost.start(node: node, source: URL(fileURLWithPath: source), loginPath: loginPath)
    }

    /// 코어가 뜬 뒤 처음 읽을 것: 사용량·업데이트(기다리지 않음)와 로그인 상태
    private func bootstrap() async {
        Task {
            if let u = try? await call("getUsage", toast: false) { usage = UsageState(u) }
        }
        Task {
            if let u = try? await call("checkUpdate", toast: false) { update = UpdateState(u) }
        }
        guard let cfg = try? await call("getConfig", toast: false) else { return }
        user = cfg["user"].flatMap { if case .object = $0 { $0 } else { nil } }
        connected = true
        hostServerOn = cfg["hostServer"]?.bool ?? false
        if hostServerOn && !hostAutoStarted {
            hostAutoStarted = true
            startServer()
        }
        // 캡처 모드는 장면이 화면을 정한다
        guard capture == nil else { return }
        if cfg["loggedIn"]?.bool == true { screen = .rooms }
        else { screen = .login(serverUrl: cfg["serverUrl"]?.string ?? "http://localhost:4310") }
    }

    // MARK: 코어 호출

    /// 코어 기능 호출. 실패하면 오류 코드를 문구로 바꿔 토스트로 알리고(toast: false 면 알리지 않음) 다시 던진다
    @discardableResult
    func call(_ name: String, _ args: JSON = .object([:]), timeout: Duration? = .seconds(120), toast showToast: Bool = true) async throws -> JSON {
        guard let client else { throw CoreError.notRunning }
        do {
            return try await client.call(name, args, timeout: timeout)
        } catch {
            if showToast { toast(Self.message(error)) }
            throw error
        }
    }

    static func message(_ error: Error) -> String {
        switch error as? CoreError {
        case .remote(let code): Format.errorText(code)
        case .timeout: "응답이 없어요. 잠시 뒤 다시 해 주세요"
        default: "앱 코어와 연결이 끊겨 있어요"
        }
    }

    func toast(_ text: String) {
        toastSeq += 1
        let id = toastSeq
        toastText = text
        // 긴 글은 오래 둔다(점검표 UB4)
        let secs: Double = text.count > 40 ? 6 : 2.5
        Task {
            try? await Task.sleep(for: .seconds(secs))
            if id == toastSeq { toastText = nil }
        }
    }

    // MARK: 알림

    private func handle(_ e: CoreEvent) {
        let p = e.payload
        switch e.name {
        case "rooms:event":
            let type = p["type"]?.string
            let roomId = p["roomId"]?.int ?? p["state"]?["room"]?["id"]?.int ?? p["message"]?["roomId"]?.int
            if let roomId {
                roomEvents[roomId, default: []].append(e)
                if roomEvents[roomId, default: []].count > 500 { roomEvents[roomId]?.removeFirst(100) } // 안 열린 방의 알림이 쌓이지 않게
            }
            if let roomId { trackApproval(type: type, roomId: roomId, p) }
            if type == "room.state" {
                if let id = p["state"]?["room"]?["id"]?.int, let name = p["state"]?["room"]?["name"]?.string { roomNames[id] = name }
                roomsVersion += 1
            } else if type == "room.delete" {
                roomsVersion += 1
            }
        case "approval:ask":
            guard let r = ApprovalRequest(p) else { break }
            approvals.append(r)
            approvalPresenter.sync(self)
            if let rid = r.roomId, roomNames[rid] == nil { Task { await loadRoomNames() } }
        case "approval:close":
            let rid = p["requestId"]?.int
            approvals.removeAll { $0.requestId == rid }
            approvalPresenter.sync(self)
        case "conn:status":
            connected = p["connected"]?.bool ?? true
            if p["reason"]?.string == "UNAUTHENTICATED" {
                connected = true
                Task { await forceLogout(notice: Format.errorText("UNAUTHENTICATED")) }
            }
        case "usage":
            usage = UsageState(p)
        case "update":
            update = UpdateState(p)
        case "relaunch":
            MacActions.relaunch()
        case "capture:shot":
            capture?.shot(p)
        case "capture:done":
            capture?.done(ok: p["ok"]?.bool ?? false)
        default:
            break
        }
    }

    /// run.approval 알림과, 끝난 요청의 대기 표시 지우기
    private func trackApproval(type: String?, roomId: Int, _ p: JSON) {
        switch type {
        case "run.approval":
            guard let rid = p["requestId"]?.int else { return }
            if p["state"]?.string == "pending" {
                roomApprovals[roomId, default: [:]][rid] = ApprovalWait(userName: p["userName"]?.string ?? "", toolName: p["toolName"]?.string ?? "")
            } else {
                roomApprovals[roomId]?[rid] = nil
            }
        case "message.new", "message.update":
            if let m = p["message"], m["kind"]?.string == "claude_request", m["status"]?.string != "running", let id = m["id"]?.int {
                roomApprovals[roomId]?[id] = nil
            }
        default:
            break
        }
    }

    /// 방 알림을 꺼내 가면서 비운다
    func takeRoomEvents(_ roomId: Int) -> [CoreEvent] {
        guard let events = roomEvents[roomId], !events.isEmpty else { return [] }
        roomEvents[roomId] = nil
        return events
    }

    // MARK: 로그인·로그아웃·화면

    /// 코어가 직접 로그인한 경우(캡처)처럼 앱이 사용자 정보를 모를 때 채운다
    func ensureUser() async {
        guard user == nil, let cfg = try? await call("getConfig", toast: false) else { return }
        user = cfg["user"].flatMap { if case .object = $0 { $0 } else { nil } }
    }

    func authenticate(signup: Bool, serverUrl: String, email: String, password: String, name: String) async throws {
        var args: [String: JSON] = ["serverUrl": .string(serverUrl), "email": .string(email), "password": .string(password)]
        if signup { args["name"] = .string(name) }
        user = try await call(signup ? "signup" : "login", .object(args), toast: false)
        loginNotice = nil
        screen = .rooms
    }

    func logout() async {
        _ = try? await call("logout")
        user = nil
        claude = nil
        let cfg = try? await call("getConfig", toast: false)
        screen = .login(serverUrl: cfg?["serverUrl"]?.string ?? "http://localhost:4310")
    }

    private func forceLogout(notice: String) async {
        _ = try? await call("logout", toast: false)
        user = nil
        claude = nil
        loginNotice = notice
        let cfg = try? await call("getConfig", toast: false)
        screen = .login(serverUrl: cfg?["serverUrl"]?.string ?? "http://localhost:4310")
    }

    func refreshClaude() async {
        if let j = try? await call("claudeStatus", toast: false) { claude = ClaudeStatus(j) }
        else { claude = ClaudeStatus(.object(["loggedIn": .bool(false)])) }
        claudeLoaded = true
    }

    func openRoom(_ id: Int) {
        screen = .room(id: id, tab: "repos", preview: nil)
    }

    func checkUpdate() async {
        guard let j = try? await call("checkUpdate") else { return }
        update = UpdateState(j)
        if update.count == 0 { toast("최신 버전이에요") }
    }

    /// 업데이트 적용. 실패 문구는 call 이 토스트로 알린다
    func applyUpdate() async {
        updating = true
        defer { updating = false }
        _ = try? await call("applyUpdate", timeout: nil)
    }

    func sheetOpened(_ kind: SheetKind) { activeSheet = kind }

    /// 시트가 닫히면 기다리던 승인 창을 띄운다
    func sheetClosed(_ kind: SheetKind) {
        guard activeSheet == kind else { return }
        activeSheet = .none
        approvalPresenter.sync(self)
    }

    /// 읽기만 하는 시트를 닫는다(승인 요청이 왔을 때)
    func closeReadOnlySheet() {
        switch activeSheet {
        case .preview: currentRoom?.preview = nil
        case .update: showUpdateDetail = false
        default: break
        }
    }

    /// 승인 시트의 [허용]·[거부]
    func answerApproval(_ r: ApprovalRequest, allow: Bool) {
        approvals.removeAll { $0.id == r.id }
        approvalPresenter.sync(self)
        Task { _ = try? await call("answerApproval", .object(["id": .string(r.id), "decision": .string(allow ? "allow" : "deny")]), toast: false) }
    }

    /// 방 이름을 아직 모를 때(승인 시트 부제) 방 목록에서 채운다
    private func loadRoomNames() async {
        guard let j = try? await call("listRooms", toast: false) else { return }
        for r in j["rooms"]?.array ?? [] {
            if let id = r["id"]?.int, let name = r["name"]?.string { roomNames[id] = name }
        }
    }
}
