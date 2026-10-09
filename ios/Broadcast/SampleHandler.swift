import MirrorLinkCore
import ReplayKit

/// Runs inside iOS's broadcast process: ReplayKit hands it the screen, and it streams that to the receiver.
/// iOS allows such an extension very little memory (about 50 MB), so everything here is kept small.
final class SampleHandler: RPBroadcastSampleHandler, SenderSessionListener {
    private var session: SenderSession?
    private var peer: WebRTCPeer?
    private let suite = SharedStore.groupIdentifier(forBundleIdentifier: Bundle.main.bundleIdentifier)

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        guard let config = SharedStore.load(suite: suite) else {
            finish("Open MirrorLink, enter the code, then tap Start mirroring.")
            return
        }
        SharedStore.clearConfig(suite: suite) // a code is good for one attempt
        report(.connecting, "Connecting…")

        let peer = WebRTCPeer(quality: config.quality)
        let session = SenderSession(
            server: config.server,
            code: config.code,
            deviceName: config.deviceName,
            peer: peer,
            listener: self
        )
        self.peer = peer
        self.session = session
        session.start()
    }

    override func broadcastPaused() {}

    override func broadcastResumed() {}

    /// The person stopped sharing (Control Center, or the red status bar).
    override func broadcastFinished() {
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
        let status = BroadcastStatus(phase: phase, message: message, isProblem: problem, updatedAt: Date().timeIntervalSince1970)
        SharedStore.write(status, suite: suite)
        DarwinNotifier.post(DarwinNotifier.statusChanged)
    }

    /// Ends the broadcast and lets iOS show `message` to the person.
    private func finish(_ message: String) {
        finishBroadcastWithError(NSError(domain: "MirrorLink", code: 1, userInfo: [NSLocalizedDescriptionKey: message]))
    }
}
