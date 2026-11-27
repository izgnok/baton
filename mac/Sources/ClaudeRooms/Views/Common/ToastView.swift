import SwiftUI

struct ToastView: View {
    let text: String?

    var body: some View {
        if let text {
            Text(text)
                .typo(.ui)
                .foregroundStyle(Theme.bg)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .background(RoundedRectangle(cornerRadius: 8).fill(Theme.text))
                .frame(maxWidth: 480)
                .padding(.bottom, 24)
                .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }
}
