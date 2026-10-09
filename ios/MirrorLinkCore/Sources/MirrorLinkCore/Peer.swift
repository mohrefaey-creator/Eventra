import Foundation

/// The WebRTC side of a session, implemented by the broadcast extension (and faked in tests).
/// `SenderSession` drives it; it never touches signaling itself.
public protocol Peer: AnyObject {
    /// The receiver approved. Create the connection and report the offer through `listener`.
    func start(iceServers: [IceServer], listener: PeerListener)

    func setRemoteDescription(_ description: SessionDescription)

    func addRemoteCandidate(_ candidate: IceCandidate)

    /// Release everything. Must be safe to call more than once.
    func close()
}

public protocol PeerListener: AnyObject {
    func peerDidCreateLocalDescription(_ description: SessionDescription)
    func peerDidFindLocalCandidate(_ candidate: IceCandidate)
    func peerDidConnect()
    func peerDidFail()
}
