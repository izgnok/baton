import SwiftUI
import WebKit
import PDFKit

/// 공유 파일 미리보기(맥 기본 시트). md 는 마크다운, html 은 스크립트·외부 리소스 없이, 이미지·PDF 는 그대로, 그 밖은 고정폭 글(바이너리는 안내만)
struct PreviewSheet: View {
    let model: RoomModel
    let path: String

    private enum Content {
        case markdown([MarkdownBlock], cut: Bool)
        case html(String)
        case plain(String, cut: Bool)
        case image(NSImage)
        case pdf(PDFDocument)
        case unsupported
    }

    @Environment(\.dismiss) private var dismiss
    @Local private var content: Content?

    private var kind: PanelText.FileKind { PanelText.fileKind(path) }
    private var folder: String { PreviewText.folder(path) }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text(PreviewText.name(path)).typo(.heading).foregroundStyle(Theme.text)
                    .lineLimit(1).truncationMode(.middle).help(path)
                if !folder.isEmpty {
                    Text(folder).typo(.caption).foregroundStyle(Theme.sub)
                        .lineLimit(1).truncationMode(.middle).help(path)
                }
            }
            bodyView
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(RoundedRectangle(cornerRadius: 8).fill(kind == .html ? Color.clear : Theme.card))
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.line, lineWidth: 1))
            HStack(spacing: 8) {
                Spacer()
                Button("Finder에서 보기") { Task { await model.openShared(path, reveal: true) } }
                    .buttonStyle(.baton(.secondary, .regular))
                Button(kind == .html ? "브라우저로 열기" : "기본 앱으로 열기") { Task { await model.openShared(path, reveal: false) } }
                    .buttonStyle(.baton(.secondary, .regular))
                Button("닫기") { dismiss() }
                    .buttonStyle(.baton(.secondary, .regular))
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(24)
        .frame(minWidth: 640, idealWidth: 760, minHeight: 480, idealHeight: 560)
        .background(Theme.bg)
        .task { await load() }
        .trackSheet(.preview)
    }

    @ViewBuilder private var bodyView: some View {
        switch content {
        case nil:
            Text("불러오는 중…").typo(.ui).foregroundStyle(Theme.sub)
        case .markdown(let blocks, let cut)?:
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    MarkdownView(blocks: blocks)
                    if cut { Text(PreviewText.cutNote).typo(.caption).foregroundStyle(Theme.sub) }
                }
                .padding(16)
            }
        case .html(let html)?:
            SafeHTMLView(html: html)
        case .plain(let text, let cut)?:
            VStack(alignment: .leading, spacing: 8) {
                MonoTextView(text: text)
                if cut { Text(PreviewText.cutNote).typo(.caption).foregroundStyle(Theme.sub).padding(.horizontal, 16).padding(.bottom, 8) }
            }
        case .image(let img)?:
            // 칸에 맞춰 줄이고 원래 크기보다 키우지 않는다
            Image(nsImage: img).resizable().aspectRatio(contentMode: .fit)
                .frame(maxWidth: img.size.width, maxHeight: img.size.height)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(16)
        case .pdf(let doc)?:
            PDFPreview(document: doc)
        case .unsupported?:
            VStack(spacing: 8) {
                Image(systemName: "doc").font(.system(size: 28)).foregroundStyle(Theme.sub)
                Text("미리보기를 지원하지 않는 파일이에요. 기본 앱으로 열어 주세요").typo(.ui).foregroundStyle(Theme.sub)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func load() async {
        // 실패하면 req 가 이유를 토스트로 알린다
        guard let j = try? await model.req("readShared", ["path": .string(path)]),
              let data = j["base64"]?.string.flatMap({ Data(base64Encoded: $0) }) else {
            model.preview = nil
            return
        }
        switch kind {
        case .html:
            content = .html(String(decoding: data, as: UTF8.self))
        case .markdown:
            let r = PreviewText.decode(data)
            content = .markdown(markdownBlocks(r.text), cut: r.cut)
        case .image:
            content = NSImage(data: data).map(Content.image) ?? .unsupported
        case .pdf:
            content = PDFDocument(data: data).map(Content.pdf) ?? .unsupported
        case .other:
            if PanelText.isBinary(data) { content = .unsupported; return }
            let r = PreviewText.decode(data)
            content = .plain(r.text, cut: r.cut)
        }
    }
}

/// 고정폭 글. 200KB 까지 글이 길 수 있어 SwiftUI Text 대신 NSTextView 로 그린다
struct MonoTextView: NSViewRepresentable {
    let text: String

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSTextView.scrollableTextView()
        scroll.drawsBackground = false
        scroll.hasHorizontalScroller = false
        if let tv = scroll.documentView as? NSTextView {
            tv.isEditable = false
            tv.isSelectable = true
            tv.drawsBackground = false
            tv.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
            tv.textContainerInset = NSSize(width: 12, height: 12)
            tv.textColor = NSColor(name: nil) { a in
                a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(hex: 0xECECEF) : NSColor(hex: 0x191F28)
            }
            tv.string = text
        }
        return scroll
    }

    func updateNSView(_ nsView: NSScrollView, context: Context) {}
}

/// HTML 미리보기. 스크립트는 실행하지 않고(allowsContentJavaScript=false), http·https 로 나가는 요청은 모두 막는다
struct SafeHTMLView: NSViewRepresentable {
    let html: String

    private static let rules = #"[{"trigger":{"url-filter":"^https?://.*"},"action":{"type":"block"}}]"#

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.defaultWebpagePreferences.allowsContentJavaScript = false
        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        let html = html
        // 차단 규칙이 준비된 뒤에 불러온다(그 전에 불러오면 외부 리소스가 새어 나갈 수 있다)
        Task { @MainActor in
            guard let list = try? await WKContentRuleListStore.default()
                .compileContentRuleList(forIdentifier: "block-network", encodedContentRuleList: Self.rules)
            else { return }
            config.userContentController.add(list)
            web.loadHTMLString(html, baseURL: nil)
        }
        return web
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator() }

    /// 글 안의 링크를 눌러도 이동하지 않는다
    final class Coordinator: NSObject, WKNavigationDelegate {
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            action.navigationType == .other ? .allow : .cancel
        }
    }
}

/// PDF 미리보기(PDFKit, 읽기 전용)
private struct PDFPreview: NSViewRepresentable {
    let document: PDFDocument
    func makeNSView(context: Context) -> PDFView {
        let v = PDFView()
        v.autoScales = true
        v.displayMode = .singlePageContinuous
        v.document = document
        return v
    }
    func updateNSView(_ v: PDFView, context: Context) { if v.document !== document { v.document = document } }
}
