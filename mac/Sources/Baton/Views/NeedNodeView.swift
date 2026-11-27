import SwiftUI

/// Node 를 못 찾았을 때 안내
struct NeedNodeView: View {
    let app: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Node가 필요해요").typo(.title).foregroundStyle(Theme.text)
            Text("이 앱은 Node.js로 만든 코어와 함께 돌아가요. 설치한 뒤 다시 확인해 주세요")
                .typo(.ui).foregroundStyle(Theme.sub).padding(.top, 8)
            Text("brew install node")
                .font(.system(size: 13, design: .monospaced)).foregroundStyle(Theme.text)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .card()
                .padding(.top, 24)
            HStack(spacing: 8) {
                Button("다시 확인") { app.retryNode() }.buttonStyle(.baton(.primary, .regular))
                Button("Node.js 내려받기") {
                    if let u = URL(string: "https://nodejs.org/ko/download") { MacActions.openURL(u) }
                }
                .buttonStyle(.baton(.secondary, .regular))
            }
            .padding(.top, 16)
        }
        .frame(width: 440, alignment: .leading)
        .padding(.top, 96)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
}
