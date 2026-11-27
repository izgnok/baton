import SwiftUI
import Observation

// MARK: 상태

struct RepoItem: Identifiable, Equatable {
    let id: Int
    var name: String
    var remoteUrl: String
    var branch: String

    init?(_ j: JSON) {
        guard let id = j["id"]?.int else { return nil }
        self.id = id
        name = j["name"]?.string ?? ""
        remoteUrl = j["remoteUrl"]?.string ?? ""
        branch = j["branch"]?.string ?? ""
    }
}

/// checkRepos 가 레포마다 돌려주는 점검 결과
struct RepoCheck: Equatable {
    var localPath: String?
    var block: String?
    var indexed: Bool
    var isProtected: Bool
    /// 이 맥에서만 작업 중인, 아직 원격에 없는 브랜치
    var pendingBranch: String?
    var worktreePath: String
    var worktreeExists: Bool

    init(_ j: JSON) {
        localPath = j["localPath"]?.string
        block = j["block"]?.string
        indexed = j["indexed"]?.bool ?? false
        isProtected = j["protected"]?.bool ?? false
        pendingBranch = j["pendingBranch"]?.string
        worktreePath = j["worktreePath"]?.string ?? ""
        worktreeExists = j["worktreeExists"]?.bool ?? false
    }
}

@MainActor @Observable
final class ReposModel {
    @ObservationIgnored private unowned let room: RoomModel
    /// 레포 id → 점검 결과. nil 이면 아직 모름
    var checks: [Int: RepoCheck]?
    var readDirs: [String] = []
    var cloning: Set<Int> = []
    var failed = false

    init(room: RoomModel) { self.room = room }

    var items: [RepoItem] { (room.state?["repos"]?.array ?? []).compactMap(RepoItem.init) }

    private func set(_ res: JSON) {
        var out: [Int: RepoCheck] = [:]
        for r in res["results"]?.array ?? [] { if let id = r["repoId"]?.int { out[id] = RepoCheck(r) } }
        checks = out
        failed = false
    }

    private func id(_ n: Int) -> JSON { .number(Double(n)) }

    func refresh() async {
        do { set(try await room.req("checkRepos")) } catch { checks = nil; failed = true }
        if let d = try? await room.req("listReadDirs", toast: false) { readDirs = (d.array ?? []).compactMap(\.string) }
    }

    func link(_ repo: RepoItem, path: String) async {
        if let r = try? await room.req("linkRepo", ["repoId": id(repo.id), "localPath": .string(path)]) { set(r) }
    }

    func pick(_ repo: RepoItem) async {
        if let p = MacActions.pickFolder() { await link(repo, path: p) }
    }

    func clone(_ repo: RepoItem) async {
        cloning.insert(repo.id)
        defer { cloning.remove(repo.id) }
        if let r = try? await room.req("cloneRepo", ["repoId": id(repo.id)], timeout: nil) { set(r) }
    }

    func openWorktree(_ path: String) async {
        if let r = try? await room.app.call("openFolder", .object(["path": .string(path)])), let p = r["path"]?.string { MacActions.open(p) }
    }

    func addDir() async {
        guard let p = MacActions.pickFolder() else { return }
        if let d = try? await room.req("addReadDir", ["path": .string(p)]) { readDirs = (d.array ?? []).compactMap(\.string) }
    }

    func removeDir(_ p: String) async {
        if let d = try? await room.req("removeReadDir", ["path": .string(p)]) { readDirs = (d.array ?? []).compactMap(\.string) }
    }

    /// 폴더를 고르면 git 정보를 읽어 돌려준다. git 레포가 아니면 토스트
    func inspect() async -> RepoDraft? {
        guard let dir = MacActions.pickFolder() else { return nil }
        guard let j = try? await room.app.call("inspectRepo", .object(["localPath": .string(dir)]), toast: false) else {
            room.app.toast("git 레포 폴더가 아니에요")
            return nil
        }
        let branch = j["branch"]?.string ?? ""
        return RepoDraft(localPath: j["localPath"]?.string ?? dir, name: j["name"]?.string ?? "",
                         remoteUrl: j["remoteUrl"]?.string ?? "", branch: branch.isEmpty ? "main" : branch)
    }

    /// 레포를 추가하고 방금 고른 폴더를 내 폴더로 연결한다
    func add(_ d: RepoDraft, name: String, remoteUrl: String, branch: String) async throws {
        let repo = try await room.req("addRepo", ["name": .string(name), "remoteUrl": .string(remoteUrl), "branch": .string(branch)], toast: false)
        if let rid = repo["id"]?.int, let r = try? await room.req("linkRepo", ["repoId": id(rid), "localPath": .string(d.localPath)]) { set(r) }
        room.app.toast("레포를 추가하고 내 폴더를 연결했어요")
    }

    func update(_ repo: RepoItem, name: String, remoteUrl: String, branch: String) async throws {
        try await room.app.call("updateRepo", .object(["repoId": id(repo.id), "name": .string(name), "remoteUrl": .string(remoteUrl), "branch": .string(branch)]), toast: false)
        room.app.toast("레포를 수정했어요")
    }

    func remove(_ repo: RepoItem) async {
        guard let r = try? await room.app.call("removeRepo", .object(["repoId": id(repo.id)])) else { return }
        room.app.toast(PanelText.repoRemovedText(keptReason: r["keptWorktree"] == nil ? nil : (r["reason"]?.string ?? "")))
    }
}

struct RepoDraft: Equatable {
    var localPath: String
    var name: String
    var remoteUrl: String
    var branch: String
}

// MARK: 화면

struct ReposPanel: View {
    let model: RoomModel
    @Local private var sheet: RepoSheet?

    private enum RepoSheet: Identifiable {
        case add(RepoDraft)
        case edit(RepoItem)
        case remove(RepoItem)

        var id: String {
            switch self {
            case .add(let d): "add:\(d.localPath)"
            case .edit(let r): "edit:\(r.id)"
            case .remove(let r): "remove:\(r.id)"
            }
        }
    }

    private var rm: ReposModel { model.repos }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(spacing: 8) {
                    if rm.items.isEmpty {
                        Text(model.isOwner ? "등록된 레포가 없어요" : "방장이 레포를 추가하면 여기 보여요")
                            .typo(.ui).foregroundStyle(Theme.sub)
                            .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 4)
                    }
                    ForEach(rm.items) { repo in
                        card(repo)
                    }
                    readDirsCard
                }
                .padding(12)
            }
            if model.isOwner {
                Rectangle().fill(Theme.line).frame(height: 1)
                Button("레포 추가") { Task { if let d = await rm.inspect() { sheet = .add(d) } } }
                    .buttonStyle(.rooms(.secondary, .regular))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
            }
        }
        .task { await rm.refresh() }
        .sheet(item: $sheet) { which in
            switch which {
            case .add(let d):
                FormSheet(title: "레포 추가", submitLabel: "추가", fields: fields(name: d.name, url: d.remoteUrl, branch: d.branch)) { v in
                    try await rm.add(d, name: v["name"] ?? "", remoteUrl: v["remoteUrl"] ?? "", branch: v["branch"] ?? "")
                }
            case .edit(let r):
                FormSheet(title: "레포 수정", submitLabel: "저장", fields: fields(name: r.name, url: r.remoteUrl, branch: r.branch)) { v in
                    try await rm.update(r, name: v["name"] ?? "", remoteUrl: v["remoteUrl"] ?? "", branch: v["branch"] ?? "")
                }
            case .remove(let r):
                ConfirmSheet(title: "\(r.name) 레포를 삭제할까요?", message: "내 원본 폴더는 그대로 둬요. 작업 폴더는 변경이 없을 때만 지워요",
                             confirmLabel: "삭제", danger: true) { Task { await rm.remove(r) } }
            }
        }
    }

    private func fields(name: String, url: String, branch: String) -> [FormSheet.Field] {
        [.init(id: "name", label: "레포 이름", value: name, placeholder: "payment-api"),
         .init(id: "remoteUrl", label: "레포 주소", value: url, placeholder: "git@github.com:team/payment-api.git"),
         .init(id: "branch", label: "브랜치", value: branch)]
    }

    // MARK: 레포 카드

    private func card(_ repo: RepoItem) -> some View {
        let check = rm.checks?[repo.id]
        let busy = rm.cloning.contains(repo.id)
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 4) {
                Text(repo.name).typo(.uiStrong).foregroundStyle(Theme.text).lineLimit(1).truncationMode(.tail).help(repo.name)
                Spacer(minLength: 4)
                moreMenu(repo)
            }
            if let check {
                let st = PanelText.repoStatus(block: check.block, indexed: check.indexed)
                HStack(spacing: 4) {
                    Circle().fill(st.ok ? Theme.successText : Theme.dangerText).frame(width: 6, height: 6)
                    Text(st.text).typo(.caption).foregroundStyle(st.ok ? Theme.successText : Theme.dangerText).lineLimit(1)
                }
                VStack(alignment: .leading, spacing: 2) {
                    LabeledValue(label: "브랜치", value: check.pendingBranch.map { "\($0) (내 맥에서만 · push 전)" } ?? repo.branch)
                    LabeledValue(label: "원격", value: repo.remoteUrl, path: true)
                    if let p = check.localPath { LabeledValue(label: "내 원본", value: p, path: true) }
                    else { LabeledValue(label: "내 원본", value: "내 맥에 없어요", muted: true) }
                    if check.worktreeExists { LabeledValue(label: "작업 폴더", value: check.worktreePath, path: true) }
                }
                if check.isProtected {
                    Text("보호 브랜치 · Claude는 push 안 해요").typo(.caption).foregroundStyle(Theme.warnText)
                        .lineLimit(1).truncationMode(.tail).help("보호 브랜치라 Claude가 push 하지 않아요")
                }
                if check.worktreeExists || check.localPath == nil {
                    HStack(spacing: 8) {
                        if check.localPath == nil {
                            Button(busy ? "받는 중…" : "clone 받기") { Task { await rm.clone(repo) } }
                                .buttonStyle(.rooms(.onCard, .small)).disabled(busy)
                            Button("폴더 고르기") { Task { await rm.pick(repo) } }
                                .buttonStyle(.rooms(.onCard, .small)).disabled(busy)
                        }
                        if check.worktreeExists {
                            Button("작업 폴더 열기") { Task { await rm.openWorktree(check.worktreePath) } }
                                .buttonStyle(.rooms(.onCard, .small))
                        }
                    }
                    .padding(.top, 2)
                }
            } else {
                Text(rm.failed ? "상태를 확인하지 못했어요" : "확인하는 중…").typo(.caption).foregroundStyle(Theme.sub)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(padding: 12)
    }

    private func moreMenu(_ repo: RepoItem) -> some View {
        Menu {
            Button("내 폴더 바꾸기") { Task { await rm.pick(repo) } }
            if model.isOwner {
                Button("수정") { sheet = .edit(repo) }
                Divider()
                Button("삭제", role: .destructive) { sheet = .remove(repo) }
            }
        } label: {
            Image(systemName: "ellipsis").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.sub)
                .frame(width: 24, height: 24).contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("더 보기")
    }

    // MARK: 함께 읽을 폴더

    private var readDirsCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("내 맥에서 함께 읽을 폴더").typo(.uiStrong).foregroundStyle(Theme.text).lineLimit(1)
            HStack(spacing: 4) {
                Text("내 요청에서만 읽어요(읽기 전용)").typo(.caption).foregroundStyle(Theme.sub).lineLimit(1)
                Image(systemName: "info.circle").font(.system(size: 11)).foregroundStyle(Theme.sub)
                    .help("내가 보낸 요청에서만 Claude가 읽어요(읽기만). 다른 사람 요청은 그 사람 맥에 등록한 폴더를 읽어요")
            }
            if rm.readDirs.isEmpty {
                Text("아직 없어요").typo(.caption).foregroundStyle(Theme.sub)
            }
            ForEach(rm.readDirs, id: \.self) { d in
                HStack(spacing: 8) {
                    Text(ToolText.shortPath(d)).typo(.caption).foregroundStyle(Theme.text)
                        .lineLimit(1).truncationMode(.middle).help(d)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button("빼기") { Task { await rm.removeDir(d) } }
                        .buttonStyle(.rooms(.onCardDanger, .small))
                }
            }
            Button("폴더 추가") { Task { await rm.addDir() } }
                .buttonStyle(.rooms(.onCard, .small))
                .padding(.top, 2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(padding: 12)
    }
}

/// 이름표(작게) + 값 한 줄. 경로는 가운데 말줄임 + 툴팁에 전체, 홈은 ~
private struct LabeledValue: View {
    let label: String
    let value: String
    var path = false
    var muted = false

    var body: some View {
        HStack(spacing: 8) {
            Text(label).typo(.caption).foregroundStyle(Theme.sub).frame(width: 52, alignment: .leading).lineLimit(1)
            Text(path ? ToolText.shortPath(value) : value).typo(.caption)
                .foregroundStyle(muted ? Theme.sub : Theme.text)
                .lineLimit(1).truncationMode(.middle).help(value)
        }
    }
}
