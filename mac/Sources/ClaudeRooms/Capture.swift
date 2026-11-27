import AppKit
import Foundation

/// 화면 캡처 모드(ROOMS_SCREENSHOT=<폴더>). 코어가 보내는 `capture:shot` 장면을 그리고 PNG 로 저장한다.
@MainActor
final class CaptureDriver {
    private let dir: URL
    private unowned let app: AppModel
    private var last: (view: String, opts: JSON, dark: Bool)?
    private var failed = false
    private let size = NSSize(width: 1100, height: 728)

    init(dir: URL, app: AppModel) {
        self.dir = dir
        self.app = app
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    func shot(_ p: JSON) {
        Task { await run(p) }
    }

    func done(ok: Bool) {
        app.shutdown()
        exit(ok && !failed ? 0 : 1)
    }

    private func run(_ p: JSON) async {
        let name = p["name"]?.string ?? "shot"
        let view = p["view"]?.string ?? "login"
        let opts = p["opts"] ?? .object([:])
        let dark = p["dark"]?.bool ?? false

        NSApp.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        // 앞 장면과 화면·옵션·다크가 같으면 다시 열지 않는다(ui 는 방 화면이 생기면 적용)
        if let l = last, l.view == view, l.opts == opts, l.dark == dark {
            // 같은 화면에 ui 만 바뀜
        } else {
            await show(view, opts)
        }
        last = (view, opts, dark)
        try? await Task.sleep(for: .milliseconds(500))
        do { try snapshot(to: dir.appendingPathComponent("\(name).png")) }
        catch {
            failed = true
            FileHandle.standardError.write(Data("캡처 실패(\(name)): \(error)\n".utf8))
        }
        _ = try? await app.call("captureAck", .object(["name": .string(name)]), toast: false)
    }

    private func show(_ view: String, _ opts: JSON) async {
        switch view {
        case "login":
            app.screen = .login(serverUrl: opts["serverUrl"]?.string ?? "http://localhost:4310")
        case "rooms":
            await app.ensureUser()
            app.roomsLoaded = false
            app.claudeLoaded = false
            app.screen = .rooms
            for _ in 0..<50 where !(app.roomsLoaded && app.claudeLoaded) { try? await Task.sleep(for: .milliseconds(100)) }
        case "room":
            await app.ensureUser()
            app.screen = .room(id: opts["roomId"]?.int ?? 0, tab: opts["tab"]?.string ?? "repos", preview: opts["preview"]?.string)
        default:
            break
        }
    }

    private func snapshot(to url: URL) throws {
        guard let window = NSApp.windows.first(where: { $0.contentView != nil && $0.isVisible }), let view = window.contentView else {
            throw CocoaError(.fileNoSuchFile)
        }
        view.layoutSubtreeIfNeeded()
        let b = view.bounds
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: Int(b.width), pixelsHigh: Int(b.height), bitsPerSample: 8,
            samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
        else { throw CocoaError(.fileWriteUnknown) }
        rep.size = b.size
        view.cacheDisplay(in: b, to: rep)
        guard let png = rep.representation(using: .png, properties: [:]) else { throw CocoaError(.fileWriteUnknown) }
        try png.write(to: url)
    }

    /// 캡처 창 크기를 1100×728(콘텐츠)로 맞춘다
    func prepareWindow() {
        guard let w = NSApp.windows.first(where: { $0.contentView != nil }) else { return }
        w.setContentSize(size)
        w.center()
    }
}
