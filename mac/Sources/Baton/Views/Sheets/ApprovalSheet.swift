import AppKit
import SwiftUI

/// 코어의 승인 질문(approval:ask)
struct ApprovalRequest: Identifiable, Equatable {
    let id: String
    let requestId: Int?
    let roomId: Int?
    let toolName: String
    let input: JSON

    init?(_ p: JSON) {
        guard let id = p["id"]?.string else { return nil }
        self.id = id
        requestId = p["requestId"]?.int
        roomId = p["roomId"]?.int
        toolName = p["toolName"]?.string ?? ""
        input = p["input"] ?? .null
    }
}

/// Claude 가 허락을 구하는 창. 응답해야 닫힌다(닫기·Esc 없음). 도구 이름·경로·내용을 읽는 형태로 보여 준다
struct ApprovalSheet: View {
    let app: AppModel
    let request: ApprovalRequest
    @Local private var showJSON = false

    private var summary: ApprovalText.Summary { ApprovalText.summary(name: request.toolName, input: request.input) }
    private var roomName: String { request.roomId.flatMap { app.roomNames[$0] } ?? "" }
    private var remaining: Int { max(0, app.approvals.count - 1) }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text("Claude가 허락을 구해요").typo(.heading).foregroundStyle(Theme.text)
                    Spacer(minLength: 8)
                    if remaining > 0 { Text("남은 승인 \(remaining)개").typo(.caption).foregroundStyle(Theme.sub) }
                }
                Text(roomName.isEmpty ? "내 요청" : "\(roomName) · 내 요청").typo(.caption).foregroundStyle(Theme.sub)
                    .lineLimit(1).truncationMode(.tail)
            }
            card
            HStack(spacing: 8) {
                Spacer()
                Button("거부") { app.answerApproval(request, allow: false) }
                    .buttonStyle(.baton(.secondary, .regular, fill: true)).frame(width: 88)
                Button("허용") { app.answerApproval(request, allow: true) }
                    .buttonStyle(.baton(.primary, .regular, fill: true)).frame(width: 88)
            }
        }
        .padding(24)
        .frame(width: 480)
        .fixedSize(horizontal: false, vertical: true)
        .background(Theme.bg)
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(summary.toolLabel).typo(.heading).foregroundStyle(Theme.text)
                if summary.toolLabel != summary.toolName && !summary.toolName.isEmpty {
                    Text(summary.toolName).typo(.caption).foregroundStyle(Theme.sub)
                }
            }
            if let path = summary.path {
                Text(path).typo(.ui).foregroundStyle(Theme.text)
                    .lineLimit(1).truncationMode(.middle).help(summary.fullPath ?? path)
            }
            bodyView
            VStack(alignment: .leading, spacing: 8) {
                Button(showJSON ? "접기" : "자세히") { showJSON.toggle() }
                    .buttonStyle(TextButtonStyle(color: Theme.accentText))
                    .padding(.leading, -6)
                if showJSON {
                    ScrollView {
                        Text(ApprovalText.prettyJSON(request.input))
                            .font(.system(size: 12, design: .monospaced)).foregroundStyle(Theme.sub)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                    }
                    .frame(maxHeight: 160)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(padding: 16)
    }

    @ViewBuilder private var bodyView: some View {
        switch summary.body {
        case .none:
            EmptyView()
        case .text(let t):
            inner { ScrollView { Text(t).typo(.ui).foregroundStyle(Theme.text).lineSpacing(4).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled) }.frame(maxHeight: 220) }
        case .command(let c):
            inner { ScrollView { Text(c).font(.system(size: 12, design: .monospaced)).foregroundStyle(Theme.text).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled) }.frame(maxHeight: 120) }
        case .fields(let fs):
            inner {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(fs.enumerated()), id: \.offset) { _, f in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(f.label).typo(.caption).foregroundStyle(Theme.sub)
                            Text(f.value).typo(.ui).foregroundStyle(Theme.text).lineLimit(4).textSelection(.enabled)
                        }
                    }
                }
            }
        }
    }

    private func inner<C: View>(@ViewBuilder _ c: () -> C) -> some View {
        c().padding(12).frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: Theme.radius).fill(Theme.bg))
    }
}

/// 승인 창을 창에 붙는 맥 기본 시트로 하나씩 띄운다. 여러 개면 앞 것에 답한 뒤 다음 것이 뜬다
@MainActor
final class ApprovalPresenter {
    private var sheet: NSWindow?
    private var shownId: String?

    /// AppModel.approvals 의 맨 앞과 지금 떠 있는 것을 맞춘다
    func sync(_ app: AppModel) {
        let want = app.approvals.first
        if let shown = shownId, shown != want?.id {
            if let s = sheet { s.sheetParent?.endSheet(s) }
            sheet = nil
            shownId = nil
            retry(app, after: 300)
            return
        }
        guard shownId == nil, let want else { return }
        switch SheetPolicy.onApproval(open: app.activeSheet) {
        case .showNow: break
        case .closeSheetThenShow:
            app.closeReadOnlySheet() // 닫히면 sheetClosed 가 다시 부른다. 못 닫았을 때를 위해 한 번 더 확인
            retry(app, after: 600)
            return
        case .waitWithBanner:
            return // 띠가 알리고, 그 시트가 닫히면 sheetClosed 가 다시 부른다
        }
        guard let host = Self.mainWindow else { retry(app, after: 300); return }
        let hc = NSHostingController(rootView: ApprovalSheet(app: app, request: want))
        hc.sizingOptions = [.preferredContentSize]
        let w = NSWindow(contentViewController: hc)
        w.styleMask = [.titled]
        sheet = w
        shownId = want.id
        host.beginSheet(w)
    }

    /// 캡처가 시트 창을 함께 찍는다
    var window: NSWindow? { sheet }

    private func retry(_ app: AppModel, after ms: Int) {
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(ms))
            sync(app)
        }
    }

    static var mainWindow: NSWindow? {
        NSApp.windows.first { $0.isVisible && !($0 is NSPanel) && $0.sheetParent == nil && $0.contentView != nil && $0.canBecomeMain }
    }
}
