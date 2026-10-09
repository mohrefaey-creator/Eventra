import Foundation

/// Sends short progress lines to the server's /api/diag (only exists when the server was started with DIAG=1).
/// A first run of a new app on a real phone is hard to watch; this lets whoever runs the server see how far it got.
/// Lines are plain text and never include passwords or codes in full.
enum Diag {
    private static let who = AppIdentity.isExtensionProcess ? "ext" : "app"
    private static let pending = DispatchGroup()

    static func log(_ message: String, server: String? = nil, as label: String? = nil) {
        let base = server ?? AppIdentity.builtInServer ?? ""
        guard !base.isEmpty, let url = URL(string: base + "/api/diag") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 8
        request.setValue("text/plain; charset=utf-8", forHTTPHeaderField: "Content-Type")
        request.httpBody = "[\(label ?? who)] \(message)".data(using: .utf8)
        pending.enter()
        URLSession.shared.dataTask(with: request) { _, _, _ in pending.leave() }.resume()
    }

    /// Waits (briefly) for lines that are still on their way. The broadcast part calls this before it ends itself,
    /// because iOS stops the process right after, which would otherwise swallow the last and most useful lines.
    static func flush(timeout: TimeInterval = 2.5) {
        _ = pending.wait(timeout: .now() + timeout)
    }
}
