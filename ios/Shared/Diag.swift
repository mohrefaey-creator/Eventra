import Foundation

/// Sends short progress lines to the server's /api/diag (only exists when the server was started with DIAG=1).
/// A first run of a new app on a real phone is hard to watch; this lets whoever runs the server see how far it got.
/// Lines are plain text and never include passwords or codes in full.
enum Diag {
    private static let who = AppIdentity.isExtensionProcess ? "ext" : "app"

    static func log(_ message: String, server: String? = nil) {
        let configured = Bundle.main.object(forInfoDictionaryKey: "MirrorLinkServer") as? String ?? ""
        let base = server ?? (configured.contains("$(") ? "" : configured)
        guard !base.isEmpty, let url = URL(string: base + "/api/diag") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 8
        request.setValue("text/plain; charset=utf-8", forHTTPHeaderField: "Content-Type")
        request.httpBody = "[\(who)] \(message)".data(using: .utf8)
        URLSession.shared.dataTask(with: request).resume()
    }
}
