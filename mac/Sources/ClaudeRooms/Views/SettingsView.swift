import SwiftUI
import AppKit

/// 설정 창(⌘,): 이 맥에서 서버 실행
struct SettingsView: View {
    let app: AppModel
    @Local private var copied = false

    private var host: ServerHost { app.serverHost }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Toggle(isOn: Binding(get: { app.hostServerOn }, set: { app.setHostServer($0) })) {
                    Text("이 맥에서 서버 실행").typo(.uiStrong).foregroundStyle(Theme.text)
                }
                .toggleStyle(.switch)
                Text("앱을 완전히 종료(⌘Q)하면 서버도 꺼져요").typo(.caption).foregroundStyle(Theme.sub)
            }

            VStack(alignment: .leading, spacing: 8) {
                Text(host.statusText)
                    .typo(.ui)
                    .foregroundStyle(host.state == .failed ? Theme.dangerText : host.state == .running ? Theme.successText : Theme.text)
                if host.state == .running {
                    if let url = host.lanURL {
                        HStack(spacing: 8) {
                            Text("다른 맥에서 접속할 주소: \(url)").typo(.ui).foregroundStyle(Theme.text)
                                .lineLimit(1).truncationMode(.middle).help(url)
                            Button(copied ? "복사됨" : "복사") {
                                NSPasteboard.general.clearContents()
                                NSPasteboard.general.setString(url, forType: .string)
                                copied = true
                                Task { try? await Task.sleep(for: .seconds(2)); copied = false }
                            }
                            .buttonStyle(.rooms(.onCard, .small))
                        }
                    } else {
                        Text("다른 맥에서 접속할 주소를 찾지 못했어요").typo(.caption).foregroundStyle(Theme.sub)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .card(padding: 12)

            HStack(spacing: 8) {
                Text("로그: \(host.logPathText)").typo(.caption).foregroundStyle(Theme.sub)
                    .lineLimit(1).truncationMode(.middle).help(host.logURL.path)
                Spacer(minLength: 0)
                Button("Finder에서 보기") { revealLog() }.buttonStyle(.rooms(.secondary, .small))
            }
        }
        .padding(20)
        .frame(width: 420)
        .background(Theme.bg)
    }

    private func revealLog() {
        let fm = FileManager.default
        if fm.fileExists(atPath: host.logURL.path) { MacActions.reveal(host.logURL.path) }
        else { MacActions.open(host.logURL.deletingLastPathComponent().path) }
    }
}
