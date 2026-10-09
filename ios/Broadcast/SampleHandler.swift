import MirrorLinkCore
import ReplayKit
import UIKit

/// Runs inside iOS's broadcast process: ReplayKit hands it the screen, and it streams that to the receiver.
/// iOS allows such an extension very little memory (about 50 MB), so everything here is kept small.
final class SampleHandler: RPBroadcastSampleHandler, SenderSessionListener {
    private var session: SenderSession?
    private var peer: WebRTCPeer?
    private lazy var suite: String? = AppIdentity.sharedSuite()

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        Diag.log("broadcast started | " + AppIdentity.describe().replacingOccurrences(of: "\n", with: " | "))
        // The setup screen's answers come first: they work however the app was installed. The app's own saved
        // form is the second source, for builds signed in Xcode where the app and extension can share storage.
        var found: BroadcastConfig?
        if let info = setupInfo, let code = info["code"] as? String, let server = info["server"] as? String {
            found = BroadcastConfig(
                server: server,
                code: code,
                deviceName: (info["name"] as? String) ?? UIDevice.current.name,
                quality: Quality.from(key: info["quality"] as? String),
                requestedAt: Date().timeIntervalSince1970
            )
            Diag.log("answers from the setup screen: server \(server), code ends \(code.suffix(2))", server: server)
        } else if let suite = suite, let saved = SharedStore.load(suite: suite) {
            found = saved
            SharedStore.clearConfig(suite: suite) // a code is good for one attempt
            Diag.log("answers from the app's saved form", server: saved.server)
        }
        guard let config = found else {
            Diag.log("no answers (setup keys: \(setupInfo?.keys.joined(separator: ",") ?? "none")), stopping")
            finish("MirrorLink did not get a code. Tap Start mirroring, choose MirrorLink, and type the code in the box that opens.")
            return
        }
        report(.connecting, "Connecting…")

        let peer = WebRTCPeer(quality: config.quality)
        let session = SenderSession(
            server: config.server,
            code: config.code,
            deviceName: config.deviceName,
            peer: peer,
            listener: self
        )
        peer.trace = { Diag.log("video: " + $0, server: config.server) }
        session.trace = { Diag.log("session: " + $0, server: config.server) }
        self.peer = peer
        self.session = session
        session.start()
    }

    override func broadcastPaused() {}

    override func broadcastResumed() {}

    /// The person stopped sharing (Control Center, or the red status bar).
    override func broadcastFinished() {
        Diag.log("broadcast finished by iOS or the person")
        session?.stop()
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        if sampleBufferType == .video {
            peer?.push(sampleBuffer)
        }
    }

    // MARK: - SenderSessionListener

    func sessionDidChange(state: SenderSession.State) {
        switch state {
        case .idle, .ended:
            break
        case .connecting:
            report(.connecting, "Connecting…")
        case .waitingApproval:
            report(.waitingApproval, nil)
        case .negotiating:
            report(.connecting, "Approved. Connecting…")
        case .live:
            report(.live, nil)
        }
    }

    func sessionDidEnd(reason: SenderSession.EndReason) {
        report(.ended, reason.message, problem: reason.isProblem)
        // When the person stopped it themselves iOS is already tearing the broadcast down.
        if reason != .stopped {
            finish(reason.message)
        }
    }

    // MARK: - helpers

    private func report(_ phase: BroadcastStatus.Phase, _ message: String?, problem: Bool = false) {
        guard let suite = suite else { return }
        let status = BroadcastStatus(phase: phase, message: message, isProblem: problem, updatedAt: Date().timeIntervalSince1970)
        SharedStore.write(status, suite: suite)
        DarwinNotifier.post(DarwinNotifier.statusChanged)
    }

    /// Ends the broadcast and lets iOS show `message` to the person.
    private func finish(_ message: String) {
        finishBroadcastWithError(NSError(domain: "MirrorLink", code: 1, userInfo: [NSLocalizedDescriptionKey: message]))
    }
}
