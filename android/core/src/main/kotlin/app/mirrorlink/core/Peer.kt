package app.mirrorlink.core

/**
 * The WebRTC side of a session, implemented by the Android app (and faked in tests).
 * [SenderSession] drives it; it never touches signaling itself.
 */
interface Peer {
    /** The receiver approved. Capture the screen, create the connection and report the offer via [listener]. */
    fun start(iceServers: List<IceServer>, listener: Listener)

    fun setRemoteDescription(description: SessionDescription)

    fun addRemoteCandidate(candidate: IceCandidate)

    /** Release everything. Must be safe to call more than once. */
    fun close()

    interface Listener {
        fun onLocalDescription(description: SessionDescription)
        fun onLocalCandidate(candidate: IceCandidate)
        fun onConnected()
        fun onFailed()
    }
}
