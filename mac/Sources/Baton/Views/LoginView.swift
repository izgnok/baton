import SwiftUI

struct LoginView: View {
    let app: AppModel
    @Local private var server: String
    @Local private var email = ""
    @Local private var password = ""
    @Local private var name = ""
    @Local private var signup = false
    @Local private var busy = false
    @Local private var error: String
    @FocusState private var focus: Field?

    enum Field { case email, password, name, server }

    init(app: AppModel, serverUrl: String) {
        self.app = app
        _server = State(initialValue: serverUrl)
        _error = State(initialValue: app.loginNotice ?? "")
    }

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 0) {
                Text("Baton").typo(.title).foregroundStyle(Theme.text)
                Text("팀원과 한 방에서 채팅하고 Claude에게 일을 맡겨요")
                    .typo(.ui).foregroundStyle(Theme.sub).lineLimit(1).padding(.top, 4)

                VStack(alignment: .leading, spacing: 16) {
                    field("이메일") {
                        TextField("", text: $email)
                            .placeholder("name@company.com", when: email.isEmpty)
                            .textContentType(.username)
                            .focused($focus, equals: .email)
                            .inputBox(focused: focus == .email)
                    }
                    field("비밀번호") {
                        SecureField("", text: $password)
                            .textContentType(signup ? .newPassword : .password)
                            .focused($focus, equals: .password)
                            .inputBox(focused: focus == .password)
                    }
                    if signup {
                        field("이름") {
                            TextField("", text: $name)
                                .placeholder("채팅방에 보일 이름", when: name.isEmpty)
                                .focused($focus, equals: .name)
                                .inputBox(focused: focus == .name)
                        }
                    }
                }
                .padding(.top, 32)

                Text(error).typo(.ui).foregroundStyle(Theme.dangerText)
                    .frame(maxWidth: .infinity, minHeight: 20, alignment: .leading)
                    .padding(.top, 8)

                Button(signup ? "가입하기" : "로그인", action: submit)
                    .buttonStyle(.baton(.primary, .big, fill: true))
                    .keyboardShortcut(.defaultAction)
                    .disabled(busy)
                    .padding(.top, 8)

                Button(signup ? "계정이 있어요? 로그인" : "계정이 없어요? 가입하기") {
                    signup.toggle()
                    error = ""
                }
                .buttonStyle(.text)
                .frame(maxWidth: .infinity)
                .padding(.top, 8)

                field("서버 주소") {
                    TextField("", text: $server)
                        .focused($focus, equals: .server)
                        .inputBox(focused: focus == .server)
                }
                .padding(.top, 32)
            }
            .frame(width: 360)
            .padding(.top, 96)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onSubmit(submit)
        .onAppear { DispatchQueue.main.async { focus = .email } }
    }

    private func field<C: View>(_ label: String, @ViewBuilder _ input: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label).typo(.ui).foregroundStyle(Theme.sub)
            input().textFieldStyle(.plain).typo(.ui).foregroundStyle(Theme.text)
        }
    }

    private func submit() {
        guard !busy else { return }
        busy = true
        error = ""
        Task {
            do {
                try await app.authenticate(
                    signup: signup, serverUrl: server.trimmingCharacters(in: .whitespaces),
                    email: email.trimmingCharacters(in: .whitespaces), password: password,
                    name: name.trimmingCharacters(in: .whitespaces))
            } catch {
                self.error = AppModel.message(error)
                busy = false
            }
        }
    }
}
