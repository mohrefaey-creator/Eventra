import Foundation

/// How sharp and how heavy the mirrored picture is. Same presets as the Android app.
public enum Quality: String, Codable, CaseIterable {
    case balanced
    case sharp
    case saver

    public var longEdge: Int {
        switch self {
        case .balanced: return 1280
        case .sharp: return 1920
        case .saver: return 960
        }
    }

    public var fps: Int {
        switch self {
        case .balanced, .sharp: return 30
        case .saver: return 20
        }
    }

    public var maxBitrateBps: Int {
        switch self {
        case .balanced: return 4_000_000
        case .sharp: return 8_000_000
        case .saver: return 1_500_000
        }
    }

    public var label: String {
        switch self {
        case .balanced: return "Balanced"
        case .sharp: return "Sharp text"
        case .saver: return "Low bandwidth"
        }
    }

    public static func from(key: String?) -> Quality {
        Quality(rawValue: key ?? "") ?? .balanced
    }
}

/// What the app hands to the broadcast extension: where to connect, with which code.
public struct BroadcastConfig: Codable, Equatable {
    public var server: String
    public var code: String
    public var deviceName: String
    public var quality: Quality
    /// Seconds since 1970. Old requests are ignored so a stale code is never reused by accident.
    public var requestedAt: TimeInterval

    public init(server: String, code: String, deviceName: String, quality: Quality, requestedAt: TimeInterval) {
        self.server = server
        self.code = code
        self.deviceName = deviceName
        self.quality = quality
        self.requestedAt = requestedAt
    }
}

/// What the extension tells the app, so the app can show progress when it is in front.
public struct BroadcastStatus: Codable, Equatable {
    public enum Phase: String, Codable { case connecting, waitingApproval, live, ended }

    public var phase: Phase
    public var message: String?
    public var isProblem: Bool
    public var updatedAt: TimeInterval

    public init(phase: Phase, message: String? = nil, isProblem: Bool = false, updatedAt: TimeInterval) {
        self.phase = phase
        self.message = message
        self.isProblem = isProblem
        self.updatedAt = updatedAt
    }
}

/// The app and its broadcast extension are separate processes; they share a small App Group container.
public enum SharedStore {
    public static let maxRequestAge: TimeInterval = 10 * 60

    /// "group.<app bundle id>". The extension's own id is "<app bundle id>.broadcast", so both sides
    /// arrive at the same group name without it being written down twice. A re-signing tool may add its own
    /// ending to both ids, so ".broadcast" is taken out wherever it sits.
    public static func groupIdentifier(forBundleIdentifier id: String?) -> String {
        var base = id ?? "com.mohrefaey.mirrorlink"
        if let range = base.range(of: ".broadcast") { base.removeSubrange(range) }
        return "group." + base
    }

    private static let configKey = "mirrorlink.config"
    private static let statusKey = "mirrorlink.status"

    /// `resetStatus`: a new request starts a clean slate; a mere refresh of an unused one must not erase what a
    /// running broadcast has reported.
    public static func save(_ config: BroadcastConfig, suite: String, resetStatus: Bool = true) -> Bool {
        guard let defaults = UserDefaults(suiteName: suite), let data = try? JSONEncoder().encode(config) else { return false }
        defaults.set(data, forKey: configKey)
        if resetStatus { defaults.removeObject(forKey: statusKey) }
        return true
    }

    /// nil when nothing was saved, it cannot be read, or it is older than `maxRequestAge`.
    public static func load(suite: String, now: TimeInterval = Date().timeIntervalSince1970) -> BroadcastConfig? {
        guard let defaults = UserDefaults(suiteName: suite),
              let data = defaults.data(forKey: configKey),
              let config = try? JSONDecoder().decode(BroadcastConfig.self, from: data),
              now - config.requestedAt <= maxRequestAge
        else { return nil }
        return config
    }

    public static func clearConfig(suite: String) {
        UserDefaults(suiteName: suite)?.removeObject(forKey: configKey)
    }

    public static func write(_ status: BroadcastStatus, suite: String) {
        guard let defaults = UserDefaults(suiteName: suite), let data = try? JSONEncoder().encode(status) else { return }
        defaults.set(data, forKey: statusKey)
    }

    public static func readStatus(suite: String) -> BroadcastStatus? {
        guard let defaults = UserDefaults(suiteName: suite), let data = defaults.data(forKey: statusKey) else { return nil }
        return try? JSONDecoder().decode(BroadcastStatus.self, from: data)
    }
}
