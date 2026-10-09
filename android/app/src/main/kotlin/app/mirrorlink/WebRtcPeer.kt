package app.mirrorlink

import android.content.Context
import android.content.Intent
import android.hardware.display.DisplayManager
import android.media.projection.MediaProjection
import android.os.Handler
import android.os.Looper
import android.util.DisplayMetrics
import android.view.Display
import app.mirrorlink.core.IceCandidate
import app.mirrorlink.core.IceServer
import app.mirrorlink.core.Peer
import app.mirrorlink.core.SessionDescription
import org.webrtc.DataChannel
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpParameters
import org.webrtc.RtpSender
import org.webrtc.ScreenCapturerAndroid
import org.webrtc.SdpObserver
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import kotlin.math.roundToInt
import org.webrtc.IceCandidate as RtcIceCandidate
import org.webrtc.SessionDescription as RtcSessionDescription

/**
 * Captures the screen with MediaProjection and streams it to the receiver over WebRTC.
 * The Android-only half of a session: [app.mirrorlink.core.SenderSession] decides when to call it.
 *
 * [projectionData] is the result of the system "start recording or casting" consent screen and can
 * be used once, so a new [WebRtcPeer] is needed for every session.
 */
class WebRtcPeer(
    private val context: Context,
    private val projectionData: Intent,
    private val quality: Quality,
    /** The system (or the user, from the status bar) revoked screen capture. */
    private val onCaptureStopped: () -> Unit,
) : Peer {
    private var egl: EglBase? = null
    private var factory: PeerConnectionFactory? = null
    private var capturer: ScreenCapturerAndroid? = null
    private var surfaceHelper: SurfaceTextureHelper? = null
    private var videoSource: VideoSource? = null
    private var videoTrack: VideoTrack? = null
    private var connection: PeerConnection? = null
    private var displayListener: DisplayManager.DisplayListener? = null
    private var captureSize = 0 to 0
    private var closed = false

    /**
     * Starts capturing right away, before the receiver has approved anything. Android's one-time capture
     * permission is safest to use immediately; nothing leaves the device until [start] attaches the video
     * to a connection. Throws if the system refuses (the caller ends the session).
     */
    @Synchronized
    fun beginCapture() {
        if (closed || capturer != null) return
        ensureInitialized(context)

        val eglBase = EglBase.create().also { egl = it }
        factory = PeerConnectionFactory.builder()
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(eglBase.eglBaseContext, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(eglBase.eglBaseContext))
            .createPeerConnectionFactory()

        // true = this is a screencast, so the encoder favours sharp text over frame rate.
        val source = factory!!.createVideoSource(true).also { videoSource = it }
        val helper = SurfaceTextureHelper.create("MirrorLinkCapture", eglBase.eglBaseContext).also { surfaceHelper = it }
        val screen = ScreenCapturerAndroid(
            projectionData,
            object : MediaProjection.Callback() {
                override fun onStop() = onCaptureStopped()
            },
        ).also { capturer = it }
        screen.initialize(helper, context.applicationContext, source.capturerObserver)
        captureSize = computeCaptureSize()
        screen.startCapture(captureSize.first, captureSize.second, quality.fps)
        watchRotation()
    }

    @Synchronized
    override fun start(iceServers: List<IceServer>, listener: Peer.Listener) {
        if (closed) return
        beginCapture() // normally already running; harmless if so
        val f = factory ?: return listener.onFailed()
        val source = videoSource ?: return listener.onFailed()

        val track = f.createVideoTrack("mirrorlink-screen", source).also { videoTrack = it }
        val config = PeerConnection.RTCConfiguration(iceServers.map { it.toWebRtc() }).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
        }
        val pc = f.createPeerConnection(config, observer(listener))
        if (pc == null) {
            listener.onFailed()
            return
        }
        connection = pc
        tune(pc.addTrack(track, listOf("mirrorlink")))

        pc.createOffer(
            object : SimpleSdpObserver() {
                override fun onCreateSuccess(sdp: RtcSessionDescription) {
                    pc.setLocalDescription(
                        object : SimpleSdpObserver() {
                            override fun onSetSuccess() =
                                listener.onLocalDescription(SessionDescription(sdp.type.canonicalForm(), sdp.description))

                            override fun onSetFailure(error: String?) = listener.onFailed()
                        },
                        sdp,
                    )
                }

                override fun onCreateFailure(error: String?) = listener.onFailed()
            },
            MediaConstraints(),
        )
    }

    @Synchronized
    override fun setRemoteDescription(description: SessionDescription) {
        val pc = connection ?: return
        pc.setRemoteDescription(
            SimpleSdpObserver(),
            RtcSessionDescription(RtcSessionDescription.Type.fromCanonicalForm(description.type), description.sdp),
        )
    }

    @Synchronized
    override fun addRemoteCandidate(candidate: IceCandidate) {
        connection?.addIceCandidate(RtcIceCandidate(candidate.sdpMid, candidate.sdpMLineIndex, candidate.candidate))
    }

    @Synchronized
    override fun close() {
        if (closed) return
        closed = true
        displayListener?.let { displayManager().unregisterDisplayListener(it) }
        displayListener = null
        connection?.close()
        try {
            capturer?.stopCapture() // blocks until the capture thread has stopped
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }
        capturer?.dispose()
        surfaceHelper?.dispose()
        videoTrack?.dispose()
        videoSource?.dispose()
        connection?.dispose()
        factory?.dispose()
        egl?.release()
        capturer = null
        surfaceHelper = null
        videoTrack = null
        videoSource = null
        connection = null
        factory = null
        egl = null
    }

    // ------------------------------------------------------------------ helpers

    private fun observer(listener: Peer.Listener) = object : PeerConnection.Observer {
        override fun onIceCandidate(candidate: RtcIceCandidate) =
            listener.onLocalCandidate(IceCandidate(candidate.sdpMid, candidate.sdpMLineIndex, candidate.sdp))

        override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {
            when (newState) {
                PeerConnection.PeerConnectionState.CONNECTED -> listener.onConnected()
                PeerConnection.PeerConnectionState.FAILED -> listener.onFailed()
                else -> Unit // DISCONNECTED often recovers by itself; FAILED is the real end
            }
        }

        override fun onSignalingChange(state: PeerConnection.SignalingState) = Unit
        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) = Unit
        override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) = Unit
        override fun onIceCandidatesRemoved(candidates: Array<out RtcIceCandidate>) = Unit
        override fun onAddStream(stream: MediaStream) = Unit
        override fun onRemoveStream(stream: MediaStream) = Unit
        override fun onDataChannel(channel: DataChannel) = Unit
        override fun onRenegotiationNeeded() = Unit
    }

    /** Cap the bitrate for the chosen quality and keep text sharp rather than letting resolution drop. */
    private fun tune(sender: RtpSender) {
        val params = sender.parameters
        for (encoding in params.encodings) encoding.maxBitrateBps = quality.maxBitrateBps
        params.degradationPreference = RtpParameters.DegradationPreference.MAINTAIN_RESOLUTION
        sender.setParameters(params)
    }

    private fun displayManager() = context.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager

    /** Real screen size scaled so its long edge fits the quality setting; both sides even. */
    private fun computeCaptureSize(): Pair<Int, Int> {
        val metrics = DisplayMetrics()
        @Suppress("DEPRECATION")
        displayManager().getDisplay(Display.DEFAULT_DISPLAY).getRealMetrics(metrics)
        val longEdge = maxOf(metrics.widthPixels, metrics.heightPixels)
        val scale = minOf(1f, quality.longEdge.toFloat() / longEdge)
        fun even(pixels: Float) = (pixels * scale).roundToInt() / 2 * 2
        return even(metrics.widthPixels.toFloat()) to even(metrics.heightPixels.toFloat())
    }

    /** Rotating the device changes the screen's shape; resize the capture so the picture is not letterboxed. */
    private fun watchRotation() {
        val listener = object : DisplayManager.DisplayListener {
            override fun onDisplayAdded(displayId: Int) = Unit
            override fun onDisplayRemoved(displayId: Int) = Unit

            override fun onDisplayChanged(displayId: Int) {
                if (displayId != Display.DEFAULT_DISPLAY) return
                synchronized(this@WebRtcPeer) {
                    if (closed) return
                    val size = computeCaptureSize()
                    if (size == captureSize) return
                    captureSize = size
                    capturer?.changeCaptureFormat(size.first, size.second, quality.fps)
                }
            }
        }
        displayManager().registerDisplayListener(listener, Handler(Looper.getMainLooper()))
        displayListener = listener
    }

    private fun IceServer.toWebRtc(): PeerConnection.IceServer {
        val builder = PeerConnection.IceServer.builder(urls)
        username?.let { builder.setUsername(it) }
        credential?.let { builder.setPassword(it) }
        return builder.createIceServer()
    }

    private open class SimpleSdpObserver : SdpObserver {
        override fun onCreateSuccess(sdp: RtcSessionDescription) = Unit
        override fun onSetSuccess() = Unit
        override fun onCreateFailure(error: String?) = Unit
        override fun onSetFailure(error: String?) = Unit
    }

    private companion object {
        private var initialized = false

        @Synchronized
        fun ensureInitialized(context: Context) {
            if (initialized) return
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(context.applicationContext).createInitializationOptions(),
            )
            initialized = true
        }
    }
}
