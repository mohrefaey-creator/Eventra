import Foundation

/// One end of the signaling exchange documented in docs/PROTOCOL.md.
public struct IceCandidate: Equatable {
    public let sdpMid: String?
    public let sdpMLineIndex: Int
    public let candidate: String

    public init(sdpMid: String?, sdpMLineIndex: Int, candidate: String) {
        self.sdpMid = sdpMid
        self.sdpMLineIndex = sdpMLineIndex
        self.candidate = candidate
    }
}

public struct SessionDescription: Equatable {
    public let type: String
    public let sdp: String

    public init(type: String, sdp: String) {
        self.type = type
        self.sdp = sdp
    }
}

public enum ServerMessage: Equatable {
    case waiting
    case accepted
    case rejected(reason: String)
    case ended
    case hostLeft
    case description(SessionDescription)
    case candidate(IceCandidate)
    case error(code: String)
    case unknown
}

/// The JSON shapes exchanged with the server; identical to what public/send.js and public/receive.js use.
public enum Wire {
    public static func join(code: String, name: String) -> String {
        encode(["type": "join", "code": code, "name": name])
    }

    public static func leave() -> String {
        encode(["type": "leave"])
    }

    public static func description(_ d: SessionDescription) -> String {
        signal(["description": ["type": d.type, "sdp": d.sdp]])
    }

    public static func candidate(_ c: IceCandidate) -> String {
        let fields: [String: Any] = [
            "candidate": c.candidate,
            "sdpMid": c.sdpMid.map { $0 as Any } ?? NSNull(),
            "sdpMLineIndex": c.sdpMLineIndex,
        ]
        return signal(["candidate": fields])
    }

    private static func signal(_ data: [String: Any]) -> String {
        encode(["type": "signal", "data": data])
    }

    private static func encode(_ object: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
              let text = String(data: data, encoding: .utf8)
        else { return "{}" }
        return text
    }

    /// Never fails: anything unreadable becomes `.unknown`.
    public static func parse(_ text: String) -> ServerMessage {
        guard let data = text.data(using: .utf8),
              let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let type = root["type"] as? String
        else { return .unknown }
        switch type {
        case "waiting": return .waiting
        case "accepted": return .accepted
        case "rejected": return .rejected(reason: root["reason"] as? String ?? "denied")
        case "ended": return .ended
        case "host-left": return .hostLeft
        case "error": return .error(code: root["code"] as? String ?? "unknown")
        case "signal": return parseSignal(root["data"] as? [String: Any])
        default: return .unknown
        }
    }

    private static func parseSignal(_ data: [String: Any]?) -> ServerMessage {
        guard let data = data else { return .unknown }
        if let d = data["description"] as? [String: Any], let type = d["type"] as? String, !type.isEmpty {
            return .description(SessionDescription(type: type, sdp: d["sdp"] as? String ?? ""))
        }
        if let c = data["candidate"] as? [String: Any], let line = c["candidate"] as? String, !line.isEmpty {
            let mid = c["sdpMid"] as? String // JSON null (NSNull) is not a String, so it becomes nil
            let index = (c["sdpMLineIndex"] as? NSNumber)?.intValue ?? 0
            return .candidate(IceCandidate(sdpMid: mid, sdpMLineIndex: index, candidate: line))
        }
        return .unknown
    }
}
