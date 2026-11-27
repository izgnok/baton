import AppKit

/// 맥 기능: 폴더 고르기·열기·링크·다시 실행
@MainActor
enum MacActions {
    static func pickFolder() -> String? {
        let p = NSOpenPanel()
        p.canChooseDirectories = true
        p.canChooseFiles = false
        p.allowsMultipleSelection = false
        p.canCreateDirectories = true
        return p.runModal() == .OK ? p.url?.path : nil
    }

    static func open(_ path: String) {
        NSWorkspace.shared.open(URL(fileURLWithPath: path))
    }

    static func reveal(_ path: String) {
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
    }

    /// http(s) 만 연다
    static func openURL(_ url: URL) {
        guard let s = url.scheme?.lowercased(), s == "http" || s == "https" else { return }
        NSWorkspace.shared.open(url)
    }

    /// 1초 뒤 같은 번들을 새로 띄우고 지금 인스턴스는 끝낸다(번들이 그 사이 교체돼도 새 것이 뜬다)
    static func relaunch() {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", "sleep 1; /usr/bin/open -n \"$0\"", Bundle.main.bundleURL.path]
        try? p.run()
        NSApp.terminate(nil)
    }
}
