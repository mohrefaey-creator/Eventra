import Foundation

/// A tiny cross-process "something changed" ping between the app and its broadcast extension.
/// The details travel through the shared App Group store; this only says "look again".
enum DarwinNotifier {
    static let statusChanged = "app.mirrorlink.status-changed"

    static func post(_ name: String) {
        CFNotificationCenterPostNotification(
            CFNotificationCenterGetDarwinNotifyCenter(),
            CFNotificationName(name as CFString),
            nil,
            nil,
            true
        )
    }

    /// Keep the returned token alive for as long as the handler should run. The handler runs on the main queue.
    static func observe(_ name: String, handler: @escaping () -> Void) -> AnyObject {
        Token(name: name, handler: handler)
    }

    private final class Token {
        private let name: String
        private let handler: () -> Void

        init(name: String, handler: @escaping () -> Void) {
            self.name = name
            self.handler = handler
            CFNotificationCenterAddObserver(
                CFNotificationCenterGetDarwinNotifyCenter(),
                Unmanaged.passUnretained(self).toOpaque(),
                { _, observer, _, _, _ in
                    guard let observer = observer else { return }
                    Unmanaged<Token>.fromOpaque(observer).takeUnretainedValue().fire()
                },
                name as CFString,
                nil,
                .deliverImmediately
            )
        }

        private func fire() {
            DispatchQueue.main.async(execute: handler)
        }

        deinit {
            CFNotificationCenterRemoveObserver(
                CFNotificationCenterGetDarwinNotifyCenter(),
                Unmanaged.passUnretained(self).toOpaque(),
                CFNotificationName(name as CFString),
                nil
            )
        }
    }
}
