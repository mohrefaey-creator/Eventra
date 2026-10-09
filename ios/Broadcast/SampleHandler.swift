import CoreMedia
import CoreVideo
import MirrorLinkCore
import ReplayKit
import UIKit

#if PROBE
/// The test build of the broadcast part: it has no video library inside. It only proves that iOS can start this part
/// at all, by saying so to the server's log, and then stops itself with a message.
final class SampleHandler: RPBroadcastSampleHandler {
    override init() {
        super.init()
        Diag.log("TEST BUILD: broadcast process started")
        Diag.flush(timeout: 2)
    }

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        Diag.log("TEST BUILD: broadcast started | " + AppIdentity.describe().replacingOccurrences(of: "\n", with: " | "))
        Diag.flush()
        finishBroadcastWithError(NSError(domain: "MirrorLink", code: 2, userInfo: [
            NSLocalizedDescriptionKey: "Test build: the broadcast part started correctly. It does not send video.",
        ]))
    }
}
#else
/// Runs inside iOS's broadcast process: ReplayKit hands it the screen, and it streams that to the receiver.
/// iOS allows such an extension very little memory (about 50 MB), so everything here is kept small.
final class SampleHandler: RPBroadcastSampleHandler, SenderSessionListener {
    private var session: SenderSession?
    private var peer: WebRTCPeer?
    private lazy var suite: String? = AppIdentity.sharedSuite()

    // Touched from ReplayKit's queue and the heartbeat's.
    private let counterLock = NSLock()
    private var frames = 0
    private var heartbeat: DispatchSourceTimer?

    override init() {
        super.init()
        Diag.log("broadcast process started")
        Diag.flush(timeout: 2) // iOS can stop this process at any moment; get the first line out now
    }

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        Diag.log("broadcast started | " + AppIdentity.describe().replacingOccurrences(of: "\n", with: " | "))
        startHeartbeat()

        // 1. The app's saved form, for builds where the app and this part can share storage (signed in Xcode).
        if let suite = suite, let saved = SharedStore.load(suite: suite) {
            SharedStore.clearConfig(suite: suite) // a code is good for one attempt
            Diag.log("details from the app's saved form", server: saved.server)
            begin(saved)
            return
        }

        // 2. The server: the app leaves what was typed there under the phone's own id. This is the way that works
        //    for an app re-signed with a free Apple ID, which gets no shared storage.
        guard let id = AppIdentity.vendorID, let rendezvous = AppIdentity.builtInServer else {
            finish("This copy of MirrorLink was built without a server address, so it cannot look up the code. Rebuild it with your server address.", why: "no phone id or built-in server")
            return
        }
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let result = Handoff.fetch(id: id, rendezvous: rendezvous, fallbackName: UIDevice.current.name)
            DispatchQueue.main.async {
                switch result {
                case let .found(config):
                    Diag.log("details picked up from the server, code ends \(config.code.suffix(2)), phone id \(id.prefix(8))", server: rendezvous)
                    self?.begin(config)
                case .nothingWaiting:
                    self?.finish("MirrorLink has no code for this broadcast. Open the app, type the code shown on the receiving screen, then tap Start mirroring.", why: "nothing waiting on the server for phone id \(id.prefix(8))")
                case let .failed(reason):
                    self?.finish("MirrorLink could not reach its server to get the code (\(reason)).", why: "pickup failed: \(reason)")
                }
            }
        }
    }

    private func begin(_ config: BroadcastConfig) {
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
        heartbeat?.cancel()
        session?.stop()
        Diag.flush(timeout: 1.5)
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        guard sampleBufferType == .video else { return }
        counterLock.lock()
        frames += 1
        let first = frames == 1
        counterLock.unlock()
        if first, let image = CMSampleBufferGetImageBuffer(sampleBuffer) {
            Diag.log("first screen picture: \(CVPixelBufferGetWidth(image))x\(CVPixelBufferGetHeight(image))")
        }
        peer?.push(sampleBuffer)
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
            finish(reason.message, why: "session ended: \(reason)")
        }
    }

    // MARK: - helpers

    /// A few lines early on, so a first run shows from the server's side that this process is alive and getting pictures.
    private func startHeartbeat() {
        let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        var beats = 0
        timer.schedule(deadline: .now() + 5, repeating: 10)
        timer.setEventHandler { [weak self] in
            guard let self = self else { return }
            beats += 1
            self.counterLock.lock()
            let count = self.frames
            self.counterLock.unlock()
            Diag.log("alive, \(count) pictures from the screen so far")
            if beats >= 6 { self.heartbeat?.cancel() }
        }
        heartbeat = timer
        timer.resume()
    }

    private func report(_ phase: BroadcastStatus.Phase, _ message: String?, problem: Bool = false) {
        guard let suite = suite else { return }
        let status = BroadcastStatus(phase: phase, message: message, isProblem: problem, updatedAt: Date().timeIntervalSince1970)
        SharedStore.write(status, suite: suite)
        DarwinNotifier.post(DarwinNotifier.statusChanged)
    }

    /// Ends the broadcast and lets iOS show `message` to the person. `why` goes to the server's log first.
    private func finish(_ message: String, why: String) {
        Diag.log("stopping: \(why)")
        heartbeat?.cancel()
        Diag.flush()
        finishBroadcastWithError(NSError(domain: "MirrorLink", code: 1, userInfo: [NSLocalizedDescriptionKey: message]))
    }
}
#endif
