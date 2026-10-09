import XCTest
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import MirrorLinkCore

private let waitSeconds: TimeInterval = 8

/// Drives `SenderSession` against the real Node server in this repository, with a scripted receiver on
/// the other side. This is what proves the Swift client and the web receiver speak the same protocol.
/// Skipped (not failed) when `node` is not installed.
final class SenderSessionIntegrationTests: XCTestCase {
    private static var node: NodeServer?
    private static var nodeChecked = false

    override class func setUp() {
        super.setUp()
        node = NodeServer.startOrNil()
        nodeChecked = true
    }

    override class func tearDown() {
        node?.stop()
        super.tearDown()
    }

    private var origin: String { Self.node!.origin }

    override func setUpWithError() throws {
        try XCTSkipIf(Self.node == nil, "node (or the repo's server/) is not available")
    }

    private func newSession(code: String, peer: FakePeer, recorder: Recorder, server: String? = nil) -> SenderSession {
        SenderSession(server: server ?? origin, code: code, deviceName: "Test iPad", peer: peer, listener: recorder)
    }

    func testHandoffRoundTripThroughTheRealServer() {
        let id = "3F2504E0-4F89-41D3-9A0C-0305E82C3301"
        XCTAssertEqual(Handoff.fetch(id: id, rendezvous: origin, fallbackName: "x", attempts: 1), .nothingWaiting)

        let config = BroadcastConfig(server: "http://192.168.1.5:3000", code: "123456", deviceName: "My iPhone", quality: .sharp, requestedAt: 0)
        let posted = expectation(description: "posted")
        var postError: String? = "not finished"
        Handoff.post(config, id: id, rendezvous: origin) { postError = $0; posted.fulfill() }
        wait(for: [posted], timeout: waitSeconds)
        XCTAssertNil(postError)

        guard case let .found(got) = Handoff.fetch(id: id, rendezvous: origin, fallbackName: "x", attempts: 1) else {
            return XCTFail("the details should be waiting")
        }
        XCTAssertEqual(got.code, "123456")
        XCTAssertEqual(got.server, "http://192.168.1.5:3000")
        XCTAssertEqual(got.deviceName, "My iPhone")
        XCTAssertEqual(got.quality, .sharp)
        XCTAssertEqual(Handoff.fetch(id: "AAAAAAAA-0000-0000-0000-000000000000", rendezvous: origin, fallbackName: "x", attempts: 1), .nothingWaiting)
    }

    func testPairsNegotiatesGoesLiveAndStopsCleanly() throws {
        let receiver = FakeReceiver(origin: origin)
        let code = try receiver.host()
        let peer = FakePeer()
        let rec = Recorder()
        let session = newSession(code: code, peer: peer, recorder: rec)
        session.start()

        let request = try receiver.expect("join-request")
        XCTAssertEqual(request["name"] as? String, "Test iPad")
        let peerId = try XCTUnwrap(request["peerId"] as? String)
        try rec.awaitState(.waitingApproval)

        receiver.send(["type": "accept", "peerId": peerId])
        try rec.awaitState(.negotiating)
        XCTAssertEqual(peer.started.wait(timeout: .now() + waitSeconds), .success)
        XCTAssertFalse(peer.iceServers.isEmpty, "ICE servers should come from /api/info")

        // The offer and candidate reach the receiver in the shape public/receive.js expects.
        let offer = try receiver.expect("signal")
        XCTAssertEqual(offer["peerId"] as? String, peerId)
        let description = (offer["data"] as? [String: Any])?["description"] as? [String: Any]
        XCTAssertEqual(description?["type"] as? String, "offer")
        XCTAssertEqual(description?["sdp"] as? String, "v=0 fake offer")
        let candidateMessage = try receiver.expect("signal")
        let candidate = (candidateMessage["data"] as? [String: Any])?["candidate"] as? [String: Any]
        XCTAssertEqual(candidate?["sdpMid"] as? String, "0")
        XCTAssertTrue((candidate?["candidate"] as? String ?? "").hasPrefix("candidate:"))

        // The receiver's answer and candidates reach the peer.
        receiver.send(["type": "signal", "data": ["description": ["type": "answer", "sdp": "v=0 fake answer"]]])
        XCTAssertEqual(peer.remoteDescriptions.take(timeout: waitSeconds), SessionDescription(type: "answer", sdp: "v=0 fake answer"))
        receiver.send([
            "type": "signal",
            "data": ["candidate": ["candidate": "candidate:2 1 udp 1 10.0.0.9 6000 typ host", "sdpMid": "0", "sdpMLineIndex": 0]],
        ])
        XCTAssertEqual(
            peer.remoteCandidates.take(timeout: waitSeconds),
            IceCandidate(sdpMid: "0", sdpMLineIndex: 0, candidate: "candidate:2 1 udp 1 10.0.0.9 6000 typ host")
        )

        peer.listener?.peerDidConnect()
        try rec.awaitState(.live)

        session.stop()
        XCTAssertEqual(try rec.awaitEnd(), .stopped)
        XCTAssertEqual(try receiver.expect("peer-left")["peerId"] as? String, peerId)
        XCTAssertGreaterThanOrEqual(peer.closeCount.value, 1)
        receiver.close()
    }

    func testACandidateFoundBeforeTheOfferIsHeldBackUntilTheOfferIsSent() throws {
        let receiver = FakeReceiver(origin: origin)
        let code = try receiver.host()
        let peer = FakePeer(candidateFirst: true)
        let rec = Recorder()
        newSession(code: code, peer: peer, recorder: rec).start()
        let peerId = try XCTUnwrap(try receiver.expect("join-request")["peerId"] as? String)
        receiver.send(["type": "accept", "peerId": peerId])

        let first = try XCTUnwrap(try receiver.expect("signal")["data"] as? [String: Any])
        XCTAssertNotNil(first["description"], "the offer must arrive before any candidate")
        let second = try XCTUnwrap(try receiver.expect("signal")["data"] as? [String: Any])
        XCTAssertNotNil(second["candidate"])

        peer.listener?.peerDidFail()
        _ = try rec.awaitEnd()
        receiver.close()
    }

    func testAWrongCodeEndsTheSessionAsBadCode() throws {
        let rec = Recorder()
        newSession(code: "000000", peer: FakePeer(), recorder: rec).start()
        XCTAssertEqual(try rec.awaitEnd(), .badCode)
    }

    func testADeclinedRequestEndsAsDeclinedAndNeverStartsThePeer() throws {
        let receiver = FakeReceiver(origin: origin)
        let code = try receiver.host()
        let peer = FakePeer()
        let rec = Recorder()
        newSession(code: code, peer: peer, recorder: rec).start()
        let peerId = try XCTUnwrap(try receiver.expect("join-request")["peerId"] as? String)
        receiver.send(["type": "reject", "peerId": peerId])
        XCTAssertEqual(try rec.awaitEnd(), .declined)
        XCTAssertEqual(peer.startCount.value, 0)
        receiver.close()
    }

    func testTheReceiverEndingTheSessionIsReported() throws {
        let receiver = FakeReceiver(origin: origin)
        let code = try receiver.host()
        let rec = Recorder()
        newSession(code: code, peer: FakePeer(), recorder: rec).start()
        let peerId = try XCTUnwrap(try receiver.expect("join-request")["peerId"] as? String)
        receiver.send(["type": "accept", "peerId": peerId])
        try rec.awaitState(.negotiating)
        receiver.send(["type": "end"])
        XCTAssertEqual(try rec.awaitEnd(), .endedByReceiver)
        receiver.close()
    }

    func testTheReceiverDisappearingIsReported() throws {
        let receiver = FakeReceiver(origin: origin)
        let code = try receiver.host()
        let rec = Recorder()
        newSession(code: code, peer: FakePeer(), recorder: rec).start()
        _ = try receiver.expect("join-request")
        receiver.close()
        XCTAssertEqual(try rec.awaitEnd(), .receiverLeft)
    }

    func testAPeerConnectionFailureLeavesTheReceiverInformed() throws {
        let receiver = FakeReceiver(origin: origin)
        let code = try receiver.host()
        let peer = FakePeer()
        let rec = Recorder()
        newSession(code: code, peer: peer, recorder: rec).start()
        let peerId = try XCTUnwrap(try receiver.expect("join-request")["peerId"] as? String)
        receiver.send(["type": "accept", "peerId": peerId])
        XCTAssertEqual(peer.started.wait(timeout: .now() + waitSeconds), .success)
        peer.listener?.peerDidFail()
        XCTAssertEqual(try rec.awaitEnd(), .connectionFailed)
        _ = try receiver.expect("peer-left")
        receiver.close()
    }

    func testStoppingWhileWaitingForApprovalWithdrawsTheRequest() throws {
        let receiver = FakeReceiver(origin: origin)
        let code = try receiver.host()
        let rec = Recorder()
        let session = newSession(code: code, peer: FakePeer(), recorder: rec)
        session.start()
        _ = try receiver.expect("join-request")
        try rec.awaitState(.waitingApproval)
        session.stop()
        XCTAssertEqual(try rec.awaitEnd(), .stopped)
        _ = try receiver.expect("peer-left")
        receiver.close()
    }

    func testAnUnreachableServerEndsAsServerUnreachable() throws {
        let rec = Recorder()
        newSession(code: "123456", peer: FakePeer(), recorder: rec, server: "http://127.0.0.1:1").start()
        XCTAssertEqual(try rec.awaitEnd(), .serverUnreachable)
    }

    func testASecondStartIsIgnoredAndStopAfterTheEndIsHarmless() throws {
        let receiver = FakeReceiver(origin: origin)
        let code = try receiver.host()
        let rec = Recorder()
        let session = newSession(code: code, peer: FakePeer(), recorder: rec)
        session.start()
        session.start()
        _ = try receiver.expect("join-request")
        session.stop()
        XCTAssertEqual(try rec.awaitEnd(), .stopped)
        session.stop()
        Thread.sleep(forTimeInterval: 0.3)
        XCTAssertEqual(rec.endCount.value, 1)
        receiver.close()
    }
}

// MARK: - test doubles

private struct Timeout: Error, CustomStringConvertible {
    let description: String
}

private final class Counter {
    private let lock = NSLock()
    private var count = 0
    var value: Int { lock.lock(); defer { lock.unlock() }; return count }
    func increment() { lock.lock(); count += 1; lock.unlock() }
}

private final class Mailbox<T> {
    private let condition = NSCondition()
    private var items: [T] = []

    func put(_ item: T) {
        condition.lock()
        items.append(item)
        condition.broadcast()
        condition.unlock()
    }

    func take(timeout: TimeInterval) -> T? {
        takeFirst(timeout: timeout) { _ in true }
    }

    /// Next item matching `predicate`; earlier items that do not match are skipped.
    func takeFirst(timeout: TimeInterval, where predicate: (T) -> Bool) -> T? {
        let deadline = Date().addingTimeInterval(timeout)
        condition.lock()
        defer { condition.unlock() }
        while true {
            if let index = items.firstIndex(where: predicate) {
                return items.remove(at: index)
            }
            if !condition.wait(until: deadline) { return nil }
        }
    }
}

private final class Recorder: SenderSessionListener {
    private let condition = NSCondition()
    private var states: [SenderSession.State] = []
    private var ended: SenderSession.EndReason?
    let endCount = Counter()

    func sessionDidChange(state: SenderSession.State) {
        condition.lock()
        states.append(state)
        condition.broadcast()
        condition.unlock()
    }

    func sessionDidEnd(reason: SenderSession.EndReason) {
        endCount.increment()
        condition.lock()
        ended = reason
        condition.broadcast()
        condition.unlock()
    }

    func awaitEnd() throws -> SenderSession.EndReason {
        let deadline = Date().addingTimeInterval(waitSeconds)
        condition.lock()
        defer { condition.unlock() }
        while ended == nil {
            if !condition.wait(until: deadline) { throw Timeout(description: "session did not end; states seen: \(states)") }
        }
        return ended!
    }

    func awaitState(_ state: SenderSession.State) throws {
        let deadline = Date().addingTimeInterval(waitSeconds)
        condition.lock()
        defer { condition.unlock() }
        while !states.contains(state) {
            if !condition.wait(until: deadline) { throw Timeout(description: "never reached \(state); states seen: \(states)") }
        }
    }
}

private final class FakePeer: Peer {
    private let candidateFirst: Bool
    private let lock = NSLock()
    private var storedListener: PeerListener?
    private var storedIceServers: [IceServer] = []
    let started = DispatchSemaphore(value: 0)
    let startCount = Counter()
    let closeCount = Counter()
    let remoteDescriptions = Mailbox<SessionDescription>()
    let remoteCandidates = Mailbox<IceCandidate>()

    init(candidateFirst: Bool = false) {
        self.candidateFirst = candidateFirst
    }

    var listener: PeerListener? { lock.lock(); defer { lock.unlock() }; return storedListener }
    var iceServers: [IceServer] { lock.lock(); defer { lock.unlock() }; return storedIceServers }

    func start(iceServers: [IceServer], listener: PeerListener) {
        lock.lock()
        storedIceServers = iceServers
        storedListener = listener
        lock.unlock()
        startCount.increment()
        started.signal()
        let offer = { listener.peerDidCreateLocalDescription(SessionDescription(type: "offer", sdp: "v=0 fake offer")) }
        let candidate = {
            listener.peerDidFindLocalCandidate(IceCandidate(sdpMid: "0", sdpMLineIndex: 0, candidate: "candidate:1 1 udp 2122260223 192.168.1.20 54321 typ host"))
        }
        if candidateFirst {
            candidate()
            offer()
        } else {
            offer()
            candidate()
        }
    }

    func setRemoteDescription(_ description: SessionDescription) { remoteDescriptions.put(description) }
    func addRemoteCandidate(_ candidate: IceCandidate) { remoteCandidates.put(candidate) }
    func close() { closeCount.increment() }
}

/// A scripted receiver: speaks the host side of the protocol exactly like public/receive.js.
private final class FakeReceiver {
    private let inbox = Mailbox<[String: Any]>()
    private let session = URLSession(configuration: .ephemeral)
    private let task: URLSessionWebSocketTask
    private let io: WebSocketIO

    init(origin: String) {
        task = session.webSocketTask(with: URL(string: PairingLinks.webSocketUrl(origin))!)
        io = WebSocketIO(task: task)
        task.resume()
        listen()
    }

    private func listen() {
        io.receive { [weak self] result in
            guard let self = self, case .success(let message) = result else { return }
            if case .string(let text) = message,
               let object = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] {
                self.inbox.put(object)
            }
            self.listen()
        }
    }

    func send(_ message: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: message), let text = String(data: data, encoding: .utf8) else { return }
        io.send(text)
    }

    func host() throws -> String {
        send(["type": "host"])
        guard let code = try expect("hosted")["code"] as? String else { throw Timeout(description: "no code in 'hosted'") }
        return code
    }

    /// Next message of `type`; earlier messages of other types are skipped.
    func expect(_ type: String) throws -> [String: Any] {
        guard let message = inbox.takeFirst(timeout: waitSeconds, where: { ($0["type"] as? String) == type }) else {
            throw Timeout(description: "timed out waiting for '\(type)'")
        }
        return message
    }

    func close() {
        task.cancel(with: .normalClosure, reason: nil)
        session.finishTasksAndInvalidate()
    }
}

private final class NodeServer {
    let origin: String
    private let process: Process

    private init(process: Process, port: Int) {
        self.process = process
        origin = "http://127.0.0.1:\(port)"
    }

    func stop() {
        process.terminate()
        process.waitUntilExit()
    }

    /// nil = cannot run here (no node / no server directory).
    static func startOrNil() -> NodeServer? {
        for _ in 0..<3 {
            if let server = startOnce() { return server }
        }
        return nil
    }

    private static func startOnce() -> NodeServer? {
        var root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        while !FileManager.default.fileExists(atPath: root.appendingPathComponent("server/index.js").path) {
            let parent = root.deletingLastPathComponent()
            if parent == root { return nil }
            root = parent
        }
        let port = freePort()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["node", "server/index.js"]
        process.currentDirectoryURL = root
        var environment = ProcessInfo.processInfo.environment
        environment["PORT"] = String(port)
        environment["TLS"] = "off"
        environment["HOST"] = "127.0.0.1"
        process.environment = environment
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { return nil }

        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline {
            if !process.isRunning { return nil } // for example "node: command not found"
            if (try? ServerInfo.fetch(session: .shared, server: "http://127.0.0.1:\(port)")) != nil {
                return NodeServer(process: process, port: port)
            }
            Thread.sleep(forTimeInterval: 0.15)
        }
        process.terminate()
        return nil
    }

    /// Not guaranteed free, but the server simply fails to start on a clash and the caller tries another.
    private static func freePort() -> Int { Int.random(in: 20_000..<60_000) }
}
