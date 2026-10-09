import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// How the app tells its broadcast extension where to connect when the two cannot share storage.
///
/// A copy of the app re-signed with a free Apple ID gets no App Group, so the extension cannot read what was typed in
/// the app. Instead the app leaves the details on the server under the phone's app-vendor id (the same value inside the
/// app and its extensions, and not guessable from outside), and the extension picks them up from there.
public enum Handoff {
    public enum Pickup: Equatable {
        case found(BroadcastConfig)
        /// The server answered but has nothing for this phone (nothing typed yet, or older than five minutes).
        case nothingWaiting
        case failed(String)
    }

    /// The JSON the server expects at POST /api/handoff.
    public static func body(for config: BroadcastConfig, id: String) -> Data {
        let object: [String: String] = [
            "id": id,
            "code": config.code,
            "server": config.server,
            "name": config.deviceName,
            "quality": config.quality.rawValue,
        ]
        return (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data()
    }

    /// Reads the server's answer to GET /api/handoff.
    public static func parse(_ data: Data, fallbackName: String, now: TimeInterval = Date().timeIntervalSince1970) -> BroadcastConfig? {
        guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let code = root["code"] as? String, code.count == 6,
              let server = root["server"] as? String, PairingLinks.normalizeServer(server) != nil
        else { return nil }
        let name = (root["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? fallbackName
        return BroadcastConfig(
            server: PairingLinks.normalizeServer(server) ?? server,
            code: code,
            deviceName: name,
            quality: Quality.from(key: root["quality"] as? String),
            requestedAt: now
        )
    }

    private static func endpoint(_ rendezvous: String) -> String { rendezvous.hasSuffix("/") ? String(rendezvous.dropLast()) : rendezvous }

    /// Leaves `config` for the extension at `rendezvous` (the server's address). `completion` gets an error text, or nil.
    public static func post(_ config: BroadcastConfig, id: String, rendezvous: String, session: URLSession = .shared, completion: ((String?) -> Void)? = nil) {
        guard let url = URL(string: endpoint(rendezvous) + "/api/handoff") else {
            completion?("bad server address")
            return
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 10
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body(for: config, id: id)
        session.dataTask(with: request) { _, response, error in
            if let error = error {
                completion?(error.localizedDescription)
            } else if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                completion?("HTTP \(http.statusCode)")
            } else {
                completion?(nil)
            }
        }.resume()
    }

    /// Blocking: call off the main thread. Tries a few times, because the first request from a freshly started
    /// extension sometimes fails while the network wakes up.
    public static func fetch(id: String, rendezvous: String, fallbackName: String, session: URLSession = .shared, attempts: Int = 3) -> Pickup {
        var last = Pickup.failed("not tried")
        for attempt in 0..<max(1, attempts) {
            if attempt > 0 { Thread.sleep(forTimeInterval: 1) }
            last = fetchOnce(id: id, rendezvous: rendezvous, fallbackName: fallbackName, session: session)
            switch last {
            case .found, .nothingWaiting: return last
            case .failed: continue
            }
        }
        return last
    }

    static func fetchOnce(id: String, rendezvous: String, fallbackName: String, session: URLSession) -> Pickup {
        var components = URLComponents(string: endpoint(rendezvous) + "/api/handoff")
        components?.queryItems = [URLQueryItem(name: "id", value: id)]
        guard let url = components?.url else { return .failed("bad server address") }
        var request = URLRequest(url: url)
        request.timeoutInterval = 8
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let done = DispatchSemaphore(value: 0)
        var data: Data?
        var status = 0
        var failure: String?
        session.dataTask(with: request) { body, response, error in
            if let error = error { failure = error.localizedDescription }
            status = (response as? HTTPURLResponse)?.statusCode ?? 0
            data = body
            done.signal()
        }.resume()
        done.wait()
        if let failure = failure { return .failed(failure) }
        if status == 404 { return .nothingWaiting }
        guard (200..<300).contains(status), let data = data else { return .failed("HTTP \(status)") }
        guard let config = parse(data, fallbackName: fallbackName) else { return .failed("unreadable answer") }
        return .found(config)
    }
}
