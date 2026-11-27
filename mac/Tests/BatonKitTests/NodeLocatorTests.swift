import Testing
@testable import BatonKit

@Suite struct NodeLocatorTests {
    let brew = "/opt/homebrew/bin/node", usr = "/usr/local/bin/node"

    @Test func shellResultWins() {
        let r = NodeLocator.find(shell: "/bin/zsh", run: { _, _ in "/Users/me/.nvm/bin/node\n" }, exists: { _ in true })
        #expect(r == "/Users/me/.nvm/bin/node")
    }

    @Test func shellFailsFallsBackToHomebrew() {
        #expect(NodeLocator.find(shell: "/bin/zsh", run: { _, _ in nil }, exists: { _ in true }) == brew)
    }

    @Test func fallsBackToUsrLocal() {
        let usr = usr
        #expect(NodeLocator.find(shell: nil, run: { _, _ in nil }, exists: { $0 == usr }) == usr)
    }

    @Test func nothingFound() {
        #expect(NodeLocator.find(shell: "/bin/zsh", run: { _, _ in "" }, exists: { _ in false }) == nil)
    }

    @Test func loginBannerLinesIgnored() {
        let out = "Last login: today\nWelcome!\n  /Users/me/bin/node  \n"
        #expect(NodeLocator.find(shell: "/bin/zsh", run: { _, _ in out }, exists: { _ in true }) == "/Users/me/bin/node")
    }

    @Test func shellPathMustExist() {
        let brew = brew
        #expect(NodeLocator.find(shell: "/bin/zsh", run: { _, _ in "/gone/node" }, exists: { $0 == brew }) == brew)
    }

    @Test func loginPathUsesLastLine() {
        nonisolated(unsafe) var seen: [String] = []
        let r = NodeLocator.loginPath(shell: "/bin/zsh", run: { _, args in seen = args; return "banner\n/opt/homebrew/bin:/usr/bin" })
        #expect(r == "/opt/homebrew/bin:/usr/bin")
        #expect(seen == ["-ilc", "printf %s \"$PATH\""])
        #expect(NodeLocator.loginPath(shell: nil, run: { _, _ in "x" }) == nil)
    }
}
