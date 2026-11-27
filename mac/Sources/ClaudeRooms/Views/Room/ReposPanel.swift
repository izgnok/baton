import SwiftUI
import Observation

// MARK: 상태

struct RepoItem: Identifiable, Equatable {
    let id: Int
    var name: String
    var remoteUrl: String
    var baseBranch: String
    var workBranch: String
    /// 처음 갈라진 기준 브랜치(push 뒤 작업 브랜치가 새 기준이 돼도 남는다)
    var originBranch: String

    init?(_ j: JSON) {
        guard let id = j["id"]?.int else { return nil }
        self.id = id
        name = j["name"]?.string ?? ""
        remoteUrl = j["remoteUrl"]?.string ?? ""
        baseBranch = j["baseBranch"]?.string ?? ""
        workBranch = j["workBranch"]?.string ?? ""
        originBranch = j["originBranch"]?.string ?? baseBranch
    }
}

/// checkRepos 가 레포마다 돌려주는 값(카드가 쓰는 것만)
struct RepoCheck: Equatable {
    var localPath: String?
    var block: String?
    var worktreePath: String
    var cloning: Bool

    init(_ j: JSON) {
        localPath = j["localPath"]?.string
        block = j["block"]?.string
        worktreePath = j["worktreePath"]?.string ?? ""
        cloning = j["cloning"]?.bool ?? false
    }
}

@MainActor @Observable
final class ReposModel {
    @ObservationIgnored private unowned let room: RoomModel
    /// 레포 id → 점검 결과. nil 이면 아직 모름
    var checks: [Int: RepoCheck]?
    /// 레포 id → 사본 맞추기 결과(`local.code`: ok·local_changes·conflict·failed)
    var codeStatus: [Int: String] = [:]
    var readDirs: [String] = []
    var failed = false

    init(room: RoomModel) { self.room = room }

    var items: [RepoItem] { (room.state?["repos"]?.array ?? []).compactMap(RepoItem.init) }

    func refresh() async {
        do {
            var out: [Int: RepoCheck] = [:]
            for r in try await room.req("checkRepos")["results"]?.array ?? [] { if let id = r["repoId"]?.int { out[id] = RepoCheck(r) } }
            checks = out
            failed = false
        } catch { checks = nil; failed = true }
        if let d = try? await room.req("listReadDirs", toast: false) { readDirs = (d.array ?? []).compactMap(\.string) }
    }

    func addDir() async {
        guard let p = MacActions.pickFolder() else { return }
        if let d = try? await room.req("addReadDir", ["path": .string(p)]) { readDirs = (d.array ?? []).compactMap(\.string) }
    }

    func removeDir(_ p: String) async {
        if let d = try? await room.req("removeReadDir", ["path": .string(p)]) { readDirs = (d.array ?? []).compactMap(\.string) }
    }
}

// MARK: 화면

/// 레포 카드는 표시만 한다. 레포 추가·수정·빼기·폴더 열기는 모두 채팅으로(Claude 방 도구)
struct ReposPanel: View {
    let model: RoomModel

    private var rm: ReposModel { model.repos }

    var body: some View {
        ScrollView {
            VStack(spacing: 8) {
                if rm.items.isEmpty {
                    Text(PanelText.noReposText)
                        .typo(.ui).foregroundStyle(Theme.sub)
                        .lineLimit(1).truncationMode(.tail).help(PanelText.noReposText)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 4)
                }
                ForEach(rm.items) { repo in
                    card(repo)
                }
                readDirsCard
            }
            .padding(12)
        }
        .task { await rm.refresh() }
    }

    // MARK: 레포 카드

    private func dotColor(_ dot: PanelText.RepoDot) -> Color {
        switch dot {
        case .ok: Theme.successText
        case .receiving: Theme.sub
        case .localChanges: Theme.warn
        case .conflict, .failed: Theme.dangerText
        }
    }

    private func card(_ repo: RepoItem) -> some View {
        let check = rm.checks?[repo.id]
        let sameName = rm.items.filter { $0.name == repo.name }.count > 1
        let title = PanelText.repoTitle(name: repo.name, baseBranch: repo.baseBranch, sameName: sameName)
        let dot: PanelText.RepoDot = check.map { PanelText.repoDot(block: $0.block, cloning: $0.cloning, code: rm.codeStatus[repo.id]) }
            ?? (rm.failed ? .failed : .receiving)
        let note = check == nil && rm.failed ? "상태를 확인하지 못했어요" : PanelText.repoNote(dot)
        let branches = PanelText.branchLine(baseBranch: repo.baseBranch, workBranch: repo.workBranch)
        let tip = PanelText.repoTooltip(remoteUrl: repo.remoteUrl, localPath: check?.localPath, worktreePath: check?.worktreePath ?? "",
                                        baseBranch: repo.baseBranch, originBranch: repo.originBranch)
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(title).typo(.uiStrong).foregroundStyle(Theme.text).lineLimit(1).truncationMode(.tail)
                Spacer(minLength: 4)
                Circle().fill(dotColor(dot)).frame(width: 8, height: 8).help(PanelText.repoDotLabel(dot))
            }
            Text(branches).font(.system(size: 12, design: .monospaced)).foregroundStyle(Theme.sub)
                .lineLimit(1).truncationMode(.middle)
            if let note {
                Text(note).typo(.caption).foregroundStyle(dot == .localChanges ? Theme.warnText : Theme.dangerText)
                    .lineLimit(2).truncationMode(.tail).help(note).padding(.top, 2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(padding: 12)
        .help(tip)
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
