import SwiftUI

/// 공유 파일 탭: 안내 한 줄 · [Finder에서 열기] · 폴더별 파일 목록
struct SharedPanel: View {
    let model: RoomModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                // 안내와 버튼은 다른 줄(SH1)
                Text("고쳐서 저장하면 모두에게 반영돼요").typo(.caption).foregroundStyle(Theme.sub)
                    .lineLimit(1).truncationMode(.tail)
                Button("Finder에서 열기") { Task { await open(nil, reveal: false) } }
                    .buttonStyle(.rooms(.secondary, .small))
                    .help("이 방의 공유 폴더를 Finder에서 열어요")
                list
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
        }
        .task { await model.loadShared() }
    }

    @ViewBuilder private var list: some View {
        if let shared = model.shared {
            if shared.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Text("아직 공유된 파일이 없어요").typo(.ui).foregroundStyle(Theme.text)
                    Text("Claude가 만든 문서가 여기 모여요").typo(.caption).foregroundStyle(Theme.sub)
                }
                .padding(.top, 8)
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(PanelText.sharedGroups(shared), id: \.dir) { g in
                        if !g.dir.isEmpty {
                            Text("\(g.dir)/").typo(.captionStrong).foregroundStyle(Theme.sub)
                                .lineLimit(1).truncationMode(.middle).help("\(g.dir)/")
                                .padding(.top, 8).padding(.bottom, 2).padding(.horizontal, 8)
                        }
                        ForEach(g.files, id: \.path) { f in row(f) }
                    }
                }
            }
        } else {
            Text("불러오는 중…").typo(.ui).foregroundStyle(Theme.sub).padding(.top, 8)
        }
    }

    private func row(_ f: PanelText.SharedFile) -> some View {
        Button { model.preview = f.path } label: {
            HStack(spacing: 8) {
                Image(systemName: icon(f.path)).font(.system(size: 13)).foregroundStyle(Theme.sub).frame(width: 16)
                Text(f.name).typo(.ui).foregroundStyle(Theme.text)
                    .lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 8)
            .frame(height: 32)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(f.path)
        .simultaneousGesture(TapGesture(count: 2).onEnded { Task { await open(f.path, reveal: false) } })
        .contextMenu {
            Button("기본 앱으로 열기") { Task { await open(f.path, reveal: false) } }
            Button("Finder에서 보기") { Task { await open(f.path, reveal: true) } }
        }
    }

    private func icon(_ path: String) -> String {
        switch PanelText.fileKind(path) {
        case .markdown: "doc.text"
        case .html: "globe"
        case .other: "doc"
        }
    }

    private func open(_ path: String?, reveal: Bool) async {
        var a: [String: JSON] = ["reveal": .bool(reveal)]
        if let path { a["path"] = .string(path) }
        guard let r = try? await model.req("openShared", a), let p = r["path"]?.string else { return }
        if r["reveal"]?.bool == true { MacActions.reveal(p) } else { MacActions.open(p) }
    }
}
