import CoreMedia
import CoreVideo
import Foundation
import ImageIO
import MirrorLinkCore
import ReplayKit
import WebRTC

/// The video half of a session: turns ReplayKit's screen frames into a WebRTC video track.
/// `SenderSession` decides when to start and stop it; it never touches signaling itself.
final class WebRTCPeer: NSObject, Peer {
    private let quality: Quality
    var trace: ((String) -> Void)?
    private let lock = NSLock()
    private let queue = DispatchQueue(label: "app.mirrorlink.webrtc")

    // Guarded by `lock`.
    private var factory: RTCPeerConnectionFactory?
    private var source: RTCVideoSource?
    private var capturer: RTCVideoCapturer?
    private var track: RTCVideoTrack?
    private var connection: RTCPeerConnection?
    private weak var listener: PeerListener?
    private var lastBuffer: CVPixelBuffer?
    private var lastRotation: RTCVideoRotation = ._0
    private var lastSentAt: UInt64 = 0
    private var repeatTimer: DispatchSourceTimer?
    private var closed = false

    /// How long the screen can stay still before the last picture is sent again.
    private static let stillScreenNanos: UInt64 = 800_000_000

    init(quality: Quality) {
        self.quality = quality
        super.init()
    }

    // MARK: - Peer

    func start(iceServers: [IceServer], listener: PeerListener) {
        trace?("start, \(iceServers.count) ice server(s)")
        lock.lock()
        if closed {
            lock.unlock()
            return
        }
        self.listener = listener

        let factory = RTCPeerConnectionFactory(
            encoderFactory: H264FirstEncoderFactory(),
            decoderFactory: RTCDefaultVideoDecoderFactory()
        )
        // true = this is a screencast, so the encoder favours sharp text over frame rate.
        let sourceOrNil: RTCVideoSource? = factory.videoSource(forScreenCast: true)
        guard let source = sourceOrNil else {
            lock.unlock()
            listener.peerDidFail()
            return
        }
        // A square box keeps the picture's shape whether the device is held upright or sideways.
        source.adaptOutputFormat(toWidth: Int32(quality.longEdge), height: Int32(quality.longEdge), fps: Int32(quality.fps))
        let trackOrNil: RTCVideoTrack? = factory.videoTrack(with: source, trackId: "mirrorlink-screen")

        let config = RTCConfiguration()
        config.iceServers = iceServers.map { RTCIceServer(urlStrings: $0.urls, username: $0.username, credential: $0.credential) }
        config.sdpSemantics = .unifiedPlan
        config.continualGatheringPolicy = .gatherContinually
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        let connectionOrNil: RTCPeerConnection? = factory.peerConnection(with: config, constraints: constraints, delegate: self)

        guard let track = trackOrNil, let connection = connectionOrNil else {
            lock.unlock()
            listener.peerDidFail()
            return
        }
        let senderOrNil: RTCRtpSender? = connection.add(track, streamIds: ["mirrorlink"])
        if let sender = senderOrNil { tune(sender) }

        self.factory = factory
        self.source = source
        self.capturer = RTCVideoCapturer(delegate: source)
        self.track = track
        self.connection = connection
        startRepeating()
        let latest = lastBuffer
        let rotation = lastRotation
        lock.unlock()

        // The first picture may already have arrived while the receiver was still deciding.
        if let latest = latest { deliver(latest, rotation: rotation) }

        connection.offer(for: constraints) { [weak self] description, error in
            guard let self = self, let description = description, error == nil else {
                self?.trace?("offer failed: \(String(describing: error))")
                listener.peerDidFail()
                return
            }
            connection.setLocalDescription(description) { error in
                if error != nil {
                    self.trace?("setLocalDescription failed: \(String(describing: error))")
                    listener.peerDidFail()
                } else {
                    self.trace?("offer ready")
                    self.listener?.peerDidCreateLocalDescription(SessionDescription(type: "offer", sdp: description.sdp))
                }
            }
        }
    }

    func setRemoteDescription(_ description: SessionDescription) {
        lock.lock()
        let connection = self.connection
        lock.unlock()
        let type: RTCSdpType
        switch description.type {
        case "offer": type = .offer
        case "pranswer": type = .prAnswer
        case "rollback": type = .rollback
        default: type = .answer
        }
        connection?.setRemoteDescription(RTCSessionDescription(type: type, sdp: description.sdp)) { _ in }
    }

    func addRemoteCandidate(_ candidate: IceCandidate) {
        lock.lock()
        let connection = self.connection
        lock.unlock()
        let rtc = RTCIceCandidate(sdp: candidate.candidate, sdpMLineIndex: Int32(candidate.sdpMLineIndex), sdpMid: candidate.sdpMid)
        connection?.add(rtc) { _ in }
    }

    func close() {
        lock.lock()
        if closed {
            lock.unlock()
            return
        }
        closed = true
        repeatTimer?.cancel()
        repeatTimer = nil
        let connection = self.connection
        self.connection = nil
        track = nil
        capturer = nil
        source = nil
        factory = nil
        lastBuffer = nil
        lock.unlock()
        connection?.close()
    }

    // MARK: - frames

    /// Called by ReplayKit for every screen frame, on its own queue.
    func push(_ sampleBuffer: CMSampleBuffer) {
        guard CMSampleBufferIsValid(sampleBuffer), let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let rotation = Self.rotation(of: sampleBuffer)
        lock.lock()
        if closed {
            lock.unlock()
            return
        }
        lastBuffer = pixels
        lastRotation = rotation
        lock.unlock()
        deliver(pixels, rotation: rotation)
    }

    private func deliver(_ pixels: CVPixelBuffer, rotation: RTCVideoRotation) {
        lock.lock()
        let source = self.source
        let capturer = self.capturer
        lock.unlock()
        guard let source = source, let capturer = capturer else { return }
        let now = DispatchTime.now().uptimeNanoseconds
        let frame = RTCVideoFrame(buffer: RTCCVPixelBuffer(pixelBuffer: pixels), rotation: rotation, timeStampNs: Int64(now))
        source.capturer(capturer, didCapture: frame)
        lock.lock()
        lastSentAt = now
        lock.unlock()
    }

    /// A screen that does not change sends no new frames, so a viewer who joins late (or a lost packet) would
    /// wait forever. Repeating the last picture now and then fixes both.
    private func startRepeating() {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 0.5, repeating: 0.5)
        timer.setEventHandler { [weak self] in
            guard let self = self else { return }
            self.lock.lock()
            let idle = DispatchTime.now().uptimeNanoseconds &- self.lastSentAt
            let buffer = self.lastBuffer
            let rotation = self.lastRotation
            self.lock.unlock()
            if let buffer = buffer, idle >= Self.stillScreenNanos {
                self.deliver(buffer, rotation: rotation)
            }
        }
        timer.resume()
        repeatTimer = timer
    }

    /// ReplayKit tells how the picture is turned relative to the way it should be viewed.
    private static func rotation(of sampleBuffer: CMSampleBuffer) -> RTCVideoRotation {
        guard let raw = CMGetAttachment(sampleBuffer, key: RPVideoSampleOrientationKey as CFString, attachmentModeOut: nil) as? NSNumber,
              let orientation = CGImagePropertyOrientation(rawValue: raw.uint32Value)
        else { return ._0 }
        switch orientation {
        case .up, .upMirrored: return ._0
        case .right, .rightMirrored: return ._90
        case .down, .downMirrored: return ._180
        case .left, .leftMirrored: return ._270
        }
    }

    /// Cap the bitrate for the chosen quality and keep text sharp rather than letting resolution drop.
    private func tune(_ sender: RTCRtpSender) {
        let parameters = sender.parameters
        for encoding in parameters.encodings {
            encoding.maxBitrateBps = NSNumber(value: quality.maxBitrateBps)
            encoding.maxFramerate = NSNumber(value: quality.fps)
        }
        parameters.degradationPreference = NSNumber(value: RTCDegradationPreference.maintainResolution.rawValue)
        sender.parameters = parameters
    }
}

/// H.264 is hardware-encoded on every iPhone and iPad, which matters in a process with so little memory.
/// It is listed first so a browser picks it; the other codecs stay available as a fallback.
private final class H264FirstEncoderFactory: RTCDefaultVideoEncoderFactory {
    override func supportedCodecs() -> [RTCVideoCodecInfo] {
        let all = super.supportedCodecs()
        return all.filter { $0.name == "H264" } + all.filter { $0.name != "H264" }
    }
}

extension WebRTCPeer: RTCPeerConnectionDelegate {
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        listener?.peerDidFindLocalCandidate(
            IceCandidate(sdpMid: candidate.sdpMid, sdpMLineIndex: Int(candidate.sdpMLineIndex), candidate: candidate.sdp)
        )
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
        trace?("connection state \(newState.rawValue)")
        switch newState {
        case .connected:
            listener?.peerDidConnect()
            // Send the picture again now that someone is watching, and once more in case the first is lost.
            queue.async { self.repeatLastFrame() }
            queue.asyncAfter(deadline: .now() + 1) { self.repeatLastFrame() }
        case .failed:
            listener?.peerDidFail()
        default:
            break // "disconnected" often recovers by itself; "failed" is the real end
        }
    }

    private func repeatLastFrame() {
        lock.lock()
        let buffer = lastBuffer
        let rotation = lastRotation
        lock.unlock()
        if let buffer = buffer { deliver(buffer, rotation: rotation) }
    }
}
