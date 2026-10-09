import Foundation
import Network

/// iOS asks before an app talks to devices on the local network, and the broadcast extension has no screen
/// to show that question on. Touching the local network once from the app makes the question appear here.
enum LocalNetworkPermission {
    private static let key = "mirrorlink.askedLocalNetwork"

    static func requestOnce() {
        guard !UserDefaults.standard.bool(forKey: key) else { return }
        UserDefaults.standard.set(true, forKey: key)
        let browser = NWBrowser(for: .bonjour(type: "_mirrorlink._tcp", domain: nil), using: .tcp)
        browser.stateUpdateHandler = { _ in }
        browser.browseResultsChangedHandler = { _, _ in }
        browser.start(queue: .main)
        DispatchQueue.main.asyncAfter(deadline: .now() + 6) { browser.cancel() }
    }
}
