import Foundation
import MirrorLinkCore
import UIKit

/// Who this copy of the app really is. A re-signing tool (Sideloadly, AltStore) may change bundle identifiers and
/// App Group names when it signs the app, so nothing here assumes the names written in project.yml: it asks the
/// installed copy instead.
enum AppIdentity {
    static var isExtensionProcess: Bool { Bundle.main.bundleURL.pathExtension == "appex" }

    /// The app bundle, whether we are running in the app or inside its broadcast extension.
    static var appBundleURL: URL {
        let own = Bundle.main.bundleURL
        return isExtensionProcess ? own.deletingLastPathComponent().deletingLastPathComponent() : own
    }

    /// Bundle identifier of the installed broadcast extension, as signed on this device.
    static func broadcastExtensionID() -> String? {
        let plugins = appBundleURL.appendingPathComponent("PlugIns")
        guard let urls = try? FileManager.default.contentsOfDirectory(at: plugins, includingPropertiesForKeys: nil) else { return nil }
        for url in urls where url.pathExtension == "appex" {
            guard let bundle = Bundle(url: url), let id = bundle.bundleIdentifier else { continue }
            let extensionInfo = bundle.object(forInfoDictionaryKey: "NSExtension") as? [String: Any]
            if extensionInfo?["NSExtensionPointIdentifier"] as? String == "com.apple.broadcast-services-upload" { return id }
        }
        return nil
    }

    /// The App Groups this bundle was signed for, read from its embedded provisioning profile.
    static func appGroups(inBundleAt url: URL) -> [String] {
        guard let data = try? Data(contentsOf: url.appendingPathComponent("embedded.mobileprovision")),
              let start = data.range(of: Data("<?xml".utf8)),
              let end = data.range(of: Data("</plist>".utf8)),
              start.lowerBound < end.upperBound,
              let plist = try? PropertyListSerialization.propertyList(from: data.subdata(in: start.lowerBound..<end.upperBound), format: nil) as? [String: Any],
              let entitlements = plist["Entitlements"] as? [String: Any],
              let groups = entitlements["com.apple.security.application-groups"] as? [String]
        else { return [] }
        return groups
    }

    /// The App Group both the app and its extension can really open on this device, or nil if there is none.
    static func sharedSuite() -> String? {
        var candidates = appGroups(inBundleAt: appBundleURL).sorted()
        candidates += appGroups(inBundleAt: Bundle.main.bundleURL).sorted()
        candidates.append(SharedStore.groupIdentifier(forBundleIdentifier: Bundle.main.bundleIdentifier)) // an Xcode build
        var seen = Set<String>()
        for name in candidates where seen.insert(name).inserted {
            if FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: name) != nil { return name }
        }
        return nil
    }

    /// The id iOS gives every app and extension from the same developer on this phone, so the app and its
    /// broadcast part read the same value without sharing storage. Nobody else can guess it.
    static var vendorID: String? { UIDevice.current.identifierForVendor?.uuidString }

    /// The server written into the build (MIRRORLINK_SERVER): where the app leaves, and the broadcast part looks for,
    /// the details typed in the app. nil for a build that was never given one.
    static var builtInServer: String? {
        let configured = Bundle.main.object(forInfoDictionaryKey: "MirrorLinkServer") as? String ?? ""
        if configured.contains("$(") || configured.contains("mirror.example.com") { return nil }
        return PairingLinks.normalizeServer(configured)
    }

    /// Whether the video library that sits next to the app can be loaded by this copy (a bad signature would stop that),
    /// and what the broadcast part's own files look like. For the server's log only.
    static func videoLibraryReport() -> String {
        let fm = FileManager.default
        let library = appBundleURL.appendingPathComponent("Frameworks/WebRTC.framework")
        var parts = ["video library present: \(fm.fileExists(atPath: library.path))"]
        if let bundle = Bundle(url: library) {
            do {
                try bundle.loadAndReturnError()
                parts.append("loads: yes")
            } catch {
                parts.append("loads: NO (\(error.localizedDescription))")
            }
        }
        let plugins = appBundleURL.appendingPathComponent("PlugIns")
        for url in (try? fm.contentsOfDirectory(at: plugins, includingPropertiesForKeys: nil)) ?? [] where url.pathExtension == "appex" {
            let bundle = Bundle(url: url)
            let executable = bundle?.executableURL.map { fm.fileExists(atPath: $0.path) } ?? false
            let profile = fm.fileExists(atPath: url.appendingPathComponent("embedded.mobileprovision").path)
            parts.append("\(url.lastPathComponent): program \(executable ? "present" : "MISSING"), profile \(profile ? "present" : "MISSING")")
        }
        return parts.joined(separator: " | ")
    }

    /// A few plain lines for the screen, so a failed first run says what is wrong.
    static func describe() -> String {
        let signed = appGroups(inBundleAt: Bundle.main.bundleURL)
        return [
            "app id: \(Bundle.main.bundleIdentifier ?? "?")",
            "broadcast part: \(isExtensionProcess ? "(this is it)" : (broadcastExtensionID() ?? "NOT FOUND"))",
            "shared storage: \(sharedSuite() ?? "none (the server is used instead)")",
            "signed groups: \(signed.isEmpty ? "none" : signed.joined(separator: ", "))",
            "phone id: \(vendorID.map { String($0.prefix(8)) } ?? "none")  built-in server: \(builtInServer ?? "none")",
        ].joined(separator: "\n")
    }
}
