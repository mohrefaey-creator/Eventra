import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct IceServer: Equatable {
    public let urls: [String]
    public let username: String?
    public let credential: String?

    public init(urls: [String], username: String? = nil, credential: String? = nil) {
        self.urls = urls
        self.username = username
        self.credential = credential
    }
}

/// What the server tells a client before pairing (GET /api/info).
public struct ServerInfo: Equatable {
    public let iceServers: [IceServer]

    public static let fallback = ServerInfo(iceServers: [IceServer(urls: ["stun:stun.l.google.com:19302"])])

    public struct FetchError: Error, Equatable {
        public let message: String
    }

    /// Throws only when `json` is not JSON at all; a missing or unusable list gives `fallback`.
    public static func parse(_ json: String) throws -> ServerInfo {
        guard let data = json.data(using: .utf8),
              let root = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { throw FetchError(message: "not a JSON object") }
        guard let list = root["iceServers"] as? [[String: Any]] else { return fallback }
        let servers: [IceServer] = list.compactMap { entry in
            // RTCIceServer.urls may be a string or an array of strings.
            let urls: [String]
            if let one = entry["urls"] as? String {
                urls = [one]
            } else if let many = entry["urls"] as? [String] {
                urls = many
            } else {
                return nil
            }
            if urls.isEmpty { return nil }
            let user = (entry["username"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            let credential = (entry["credential"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            return IceServer(urls: urls, username: user, credential: credential)
        }
        return servers.isEmpty ? fallback : ServerInfo(iceServers: servers)
    }

    /// Blocking: call off the main thread. Throws on network or HTTP errors.
    public static func fetch(session: URLSession, server: String) throws -> ServerInfo {
        guard let url = URL(string: "\(server)/api/info") else { throw FetchError(message: "bad server address") }
        var request = URLRequest(url: url)
        request.timeoutInterval = 10
        let done = DispatchSemaphore(value: 0)
        var body: Data?
        var failure: Error?
        session.dataTask(with: request) { data, response, error in
            if let error = error {
                failure = error
            } else if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                failure = FetchError(message: "HTTP \(http.statusCode)")
            } else {
                body = data
            }
            done.signal()
        }.resume()
        done.wait()
        if let failure = failure { throw failure }
        guard let body = body, let text = String(data: body, encoding: .utf8) else { throw FetchError(message: "empty response") }
        return try parse(text)
    }
}
