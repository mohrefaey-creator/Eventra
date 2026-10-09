import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public protocol SenderSessionListener: AnyObject {
    /// Called from the session's queue, never for `.ended` (see `sessionDidEnd`).
    func sessionDidChange(state: SenderSession.State)

    /// Called exactly once, from the session's queue.
    func sessionDidEnd(reason: SenderSession.EndReason)
}

/// Pairs with a MirrorLink receiver and walks the sender through the protocol in docs/PROTOCOL.md:
/// join with the code, wait for approval, then hand the WebRTC offer/answer/candidates between the
/// `Peer` and the server. All state changes happen on one serial queue, so callers may use any thread.
///
/// A session is single use: after it ends (for any reason) create a new one.
public final class SenderSession: NSObject {
    public enum State: Equatable { case idle, connecting, waitingApproval, negotiating, live, ended }

    public enum EndReason: Equatable {
        case stopped
        case declined
        case timedOut
        case endedByReceiver
        case receiverLeft
        case badCode
        case busy
        case rateLimited
        case serverUnreachable
        case connectionLost
        case connectionFailed
        case error

        /// Plain-language explanation, the same wording as the Android app.
        public var message: String {
            switch self {
            case .stopped: return "Stopped sharing."
            case .declined: return "The receiving screen declined."
            case .timedOut: return "Nobody approved the request in time."
            case .endedByReceiver: return "The receiving screen ended the session."
            case .receiverLeft: return "The receiving screen went away."
            case .badCode: return "That code isn't valid, or it has expired. Check the number on the receiving screen."
            case .busy: return "That screen is already receiving from another device."
            case .rateLimited: return "Too many wrong codes. Wait a minute and try again."
            case .serverUnreachable: return "Cannot reach the MirrorLink server. Check the address and your connection."
            case .connectionLost: return "Lost connection to the server."
            case .connectionFailed: return "Could not open a direct connection. Are both devices on the same network?"
            case .error: return "Something went wrong. Try again."
            }
        }

        /// `false` for endings the person asked for themselves.
        public var isProblem: Bool { self != .stopped && self != .endedByReceiver }
    }

    /// How often the client pings, so a dead connection (Wi-Fi dropped, device asleep) is noticed.
    private static let pingInterval: TimeInterval = 20

    private let server: String
    private let code: String
    private let deviceName: String
    private let peer: Peer
    private weak var listener: SenderSessionListener?
    private let bridge = PeerBridge()
    fileprivate let worker = DispatchQueue(label: "app.mirrorlink.session")

    // Only touched on `worker`.
    private var state = State.idle
    private var urlSession: URLSession?
    private var socket: WebSocketIO?
    private var socketOpen = false
    private var iceServers: [IceServer] = []
    private var pingTimer: DispatchSourceTimer?

    // The receiver can only add a candidate after it has the offer, so hold early ones back.
    private var offerSent = false
    private var earlyCandidates: [IceCandidate] = []

    public init(server: String, code: String, deviceName: String, peer: Peer, listener: SenderSessionListener) {
        self.server = server
        self.code = code
        self.deviceName = deviceName
        self.peer = peer
        self.listener = listener
        super.init()
        bridge.session = self
    }

    public func start() {
        worker.async {
            guard self.state == .idle else { return } // a session is single use; ignore a second start
            self.setState(.connecting)
            let server = self.server
            // The HTTP fetch must not block the queue: stop() has to stay responsive meanwhile.
            DispatchQueue.global().async {
                let info: ServerInfo
                do {
                    info = try ServerInfo.fetch(session: .shared, server: server)
                } catch {
                    self.worker.async { self.end(.serverUnreachable) }
                    return
                }
                self.worker.async { self.openSocket(info) }
            }
        }
    }

    /// The user asked to stop sharing. Safe from any thread, and after the session has ended.
    public func stop() {
        worker.async {
            if self.state == .ended { return }
            self.send(Wire.leave())
            self.end(.stopped)
        }
    }

    // MARK: - worker queue

    private func setState(_ next: State) {
        state = next
        listener?.sessionDidChange(state: next)
    }

    private func openSocket(_ info: ServerInfo) {
        if state == .ended { return }
        iceServers = info.iceServers
        guard let url = URL(string: PairingLinks.webSocketUrl(server)) else {
            end(.error)
            return
        }
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        queue.underlyingQueue = worker // delegate callbacks arrive on the same serial queue
        let session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: queue)
        urlSession = session
        let task = session.webSocketTask(with: url)
        let io = WebSocketIO(task: task)
        socket = io
        task.resume()
        send(Wire.join(code: code, name: deviceName)) // queued until the connection is open
        listen(to: io)
        startPinging()
    }

    private func listen(to io: WebSocketIO) {
        io.receive { [weak self] result in
            guard let self = self else { return }
            self.worker.async { self.received(result, from: io) }
        }
    }

    private func received(_ result: Result<URLSessionWebSocketTask.Message, Error>, from io: WebSocketIO) {
        guard io === socket, state != .ended else { return }
        switch result {
        case .success(let message):
            socketOpen = true
            if case .string(let text) = message { handle(Wire.parse(text)) }
            if state != .ended { listen(to: io) }
        case .failure:
            socketGone()
        }
    }

    private func startPinging() {
        let timer = DispatchSource.makeTimerSource(queue: worker)
        timer.schedule(deadline: .now() + Self.pingInterval, repeating: Self.pingInterval)
        timer.setEventHandler { [weak self] in
            guard let self = self, self.state != .ended, let io = self.socket else { return }
            io.task.sendPing { [weak self] error in
                if error != nil { self?.worker.async { self?.socketGone() } }
            }
        }
        timer.resume()
        pingTimer = timer
    }

    private func send(_ text: String) {
        socket?.send(text)
    }

    private func socketGone() {
        if state == .ended { return }
        end(socketOpen ? .connectionLost : .serverUnreachable)
    }

    private func handle(_ message: ServerMessage) {
        if state == .ended { return }
        switch message {
        case .waiting:
            setState(.waitingApproval)
        case .accepted:
            setState(.negotiating)
            peer.start(iceServers: iceServers, listener: bridge)
        case .rejected(let reason):
            end(reason == "timeout" ? .timedOut : .declined)
        case .ended:
            end(.endedByReceiver)
        case .hostLeft:
            end(.receiverLeft)
        case .error(let code):
            switch code {
            case "bad-code": end(.badCode)
            case "busy": end(.busy)
            case "rate-limited": end(.rateLimited)
            default: end(.error)
            }
        case .description(let description):
            if negotiating { peer.setRemoteDescription(description) }
        case .candidate(let candidate):
            if negotiating { peer.addRemoteCandidate(candidate) }
        case .unknown:
            break
        }
    }

    private var negotiating: Bool { state == .negotiating || state == .live }

    fileprivate func localDescription(_ description: SessionDescription) {
        guard negotiating else { return }
        send(Wire.description(description))
        offerSent = true
        for candidate in earlyCandidates { send(Wire.candidate(candidate)) }
        earlyCandidates.removeAll()
    }

    fileprivate func localCandidate(_ candidate: IceCandidate) {
        guard negotiating else { return }
        if offerSent { send(Wire.candidate(candidate)) } else { earlyCandidates.append(candidate) }
    }

    fileprivate func peerConnected() {
        if state == .negotiating { setState(.live) }
    }

    fileprivate func peerFailed() {
        if state == .ended { return }
        send(Wire.leave())
        end(.connectionFailed)
    }

    private func end(_ reason: EndReason) {
        if state == .ended { return }
        state = .ended
        closeSocket()
        peer.close()
        listener?.sessionDidEnd(reason: reason)
    }

    private func closeSocket() {
        pingTimer?.cancel()
        pingTimer = nil
        let task = socket?.task
        let session = urlSession
        socket = nil
        urlSession = nil
        guard let task = task else {
            session?.invalidateAndCancel()
            return
        }
        // Give a queued "leave" a moment to go out before the connection is closed.
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.4) {
            task.cancel(with: .normalClosure, reason: nil)
            session?.finishTasksAndInvalidate()
        }
    }

    /// Forwards peer callbacks (any thread) onto the session queue.
    private final class PeerBridge: PeerListener {
        weak var session: SenderSession?

        func peerDidCreateLocalDescription(_ description: SessionDescription) {
            guard let session = session else { return }
            session.worker.async { session.localDescription(description) }
        }

        func peerDidFindLocalCandidate(_ candidate: IceCandidate) {
            guard let session = session else { return }
            session.worker.async { session.localCandidate(candidate) }
        }

        func peerDidConnect() {
            guard let session = session else { return }
            session.worker.async { session.peerConnected() }
        }

        func peerDidFail() {
            guard let session = session else { return }
            session.worker.async { session.peerFailed() }
        }
    }
}

extension SenderSession: URLSessionWebSocketDelegate {
    public func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        if webSocketTask === socket?.task { socketOpen = true }
    }

    public func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        if webSocketTask === socket?.task { socketGone() }
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if task === socket?.task { socketGone() }
    }
}
