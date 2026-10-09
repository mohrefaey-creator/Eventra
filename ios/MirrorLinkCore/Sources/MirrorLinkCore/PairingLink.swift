import Foundation

/// A server plus the pairing code shown on the receiving screen.
public struct PairingLink: Equatable {
    public let server: String
    public let code: String

    public init(server: String, code: String) {
        self.server = server
        self.code = code
    }
}

public enum PairingLinks {
    /// Understands what the receiver's QR code and the web sender page produce:
    ///   https://mirror.example.com/send?code=123456
    ///   mirrorlink://join?server=https%3A%2F%2Fmirror.example.com&code=123456
    /// Returns nil when `text` is neither, or has no valid 6-digit code.
    public static func parse(_ text: String) -> PairingLink? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let parts = URLComponents(string: trimmed), let scheme = parts.scheme?.lowercased() else { return nil }
        let query = queryOf(parts)
        guard let rawCode = query["code"] else { return nil }
        let code = normalizeCode(rawCode)
        guard code.count == 6 else { return nil }

        let server: String?
        switch scheme {
        case "https", "http":
            guard let host = parts.host, !host.isEmpty else { return nil }
            server = normalizeServer("\(scheme)://\(hostForURL(host))\(parts.port.map { ":\($0)" } ?? "")")
        case "mirrorlink":
            guard let given = query["server"] else { return nil }
            server = normalizeServer(given)
        default:
            server = nil
        }
        guard let server = server else { return nil }
        return PairingLink(server: server, code: code)
    }

    /// Keeps digits only, so "123 456" and "123-456" both work.
    public static func normalizeCode(_ raw: String) -> String {
        String(raw.filter { $0 >= "0" && $0 <= "9" })
    }

    /// Turns what a person typed ("mirror.example.com", "https://mirror.example.com/") into a bare
    /// origin ("https://mirror.example.com"), or nil when it cannot be a server address.
    public static func normalizeServer(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return nil }
        let withScheme = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
        guard let parts = URLComponents(string: withScheme),
              let scheme = parts.scheme?.lowercased(), scheme == "https" || scheme == "http",
              let rawHost = parts.host, !rawHost.isEmpty
        else { return nil }
        // Foundation returns IPv6 literals with brackets on some platforms and without on others.
        let host = rawHost.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        guard isPlausibleHost(host) else { return nil }
        let port = parts.port.map { ":\($0)" } ?? ""
        return "\(scheme)://\(hostForURL(host))\(port)"
    }

    /// WebSocket endpoint for a normalized server origin.
    public static func webSocketUrl(_ server: String) -> String {
        let secure = server.hasPrefix("https://")
        let rest = server.components(separatedBy: "://").dropFirst().joined(separator: "://")
        return (secure ? "wss://" : "ws://") + rest + "/ws"
    }

    // MARK: - helpers

    private static func hostForURL(_ host: String) -> String {
        let bare = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        return bare.contains(":") ? "[\(bare)]" : bare
    }

    private static func isPlausibleHost(_ host: String) -> Bool {
        if host.contains(":") { // IPv6 literal
            return host.unicodeScalars.allSatisfy { CharacterSet(charactersIn: "0123456789abcdefABCDEF:.").contains($0) }
        }
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: ".-_"))
        return host.unicodeScalars.allSatisfy { allowed.contains($0) }
    }

    private static func queryOf(_ parts: URLComponents) -> [String: String] {
        var out: [String: String] = [:]
        for item in parts.queryItems ?? [] {
            if let value = item.value, out[item.name] == nil { out[item.name] = value }
        }
        return out
    }
}
