package app.mirrorlink.core

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit

/**
 * Pairs with a MirrorLink receiver and walks the sender through the protocol in docs/PROTOCOL.md:
 * join with the code, wait for approval, then hand the WebRTC offer/answer/candidates between the
 * [Peer] and the server. All state changes happen on one worker thread, so callers may use any thread.
 *
 * A session is single use: after it ends (for any reason) create a new one.
 */
class SenderSession(
    private val server: String,
    private val code: String,
    private val deviceName: String,
    private val peer: Peer,
    private val listener: Listener,
    // The ping notices a dead connection (Wi-Fi dropped, phone asleep) within about 40 seconds.
    private val client: OkHttpClient = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build(),
) {
    enum class State { IDLE, CONNECTING, WAITING_APPROVAL, NEGOTIATING, LIVE, ENDED }

    enum class EndReason {
        STOPPED,
        DECLINED,
        TIMED_OUT,
        ENDED_BY_RECEIVER,
        RECEIVER_LEFT,
        BAD_CODE,
        BUSY,
        RATE_LIMITED,
        SERVER_UNREACHABLE,
        CONNECTION_LOST,
        CONNECTION_FAILED,
        ERROR,
    }

    interface Listener {
        /** Called from the worker thread, never for [State.ENDED] (see [onEnded]). */
        fun onState(state: State)

        /** Called exactly once, from the worker thread. */
        fun onEnded(reason: EndReason)
    }

    private val worker: ExecutorService = Executors.newSingleThreadExecutor { r ->
        Thread(r, "mirrorlink-session").apply { isDaemon = true }
    }

    // Only touched on the worker thread.
    private var state = State.IDLE
    private var socket: WebSocket? = null
    private var socketOpen = false
    private var iceServers: List<IceServer> = emptyList()

    // The receiver can only add a candidate after it has the offer, so hold early ones back.
    private var offerSent = false
    private val earlyCandidates = mutableListOf<IceCandidate>()

    fun start() {
        post {
            if (state != State.IDLE) return@post // a session is single use; ignore a second start
            setState(State.CONNECTING)
            // The HTTP fetch must not block the worker: stop() has to stay responsive meanwhile.
            Thread({
                val info = try {
                    ServerInfo.fetch(client, server)
                } catch (_: Exception) {
                    post { end(EndReason.SERVER_UNREACHABLE) }
                    return@Thread
                }
                post { openSocket(info) }
            }, "mirrorlink-info").apply { isDaemon = true }.start()
        }
    }

    /** User asked to stop sharing. Safe from any thread, and after the session has ended. */
    fun stop() {
        post {
            if (state == State.ENDED) return@post
            socket?.send(Protocol.leave())
            end(EndReason.STOPPED)
        }
    }

    // ---------------------------------------------------------------- worker thread

    private fun post(task: () -> Unit) {
        try {
            worker.execute {
                try {
                    task()
                } catch (e: Throwable) {
                    if (state != State.ENDED) end(EndReason.ERROR)
                    if (e !is Exception) throw e
                }
            }
        } catch (_: RejectedExecutionException) {
            // Session already ended and its worker shut down.
        }
    }

    private fun setState(next: State) {
        state = next
        listener.onState(next)
    }

    private fun openSocket(info: ServerInfo) {
        if (state == State.ENDED) return
        iceServers = info.iceServers
        val request = Request.Builder().url(PairingLinks.webSocketUrl(server)).build()
        socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) = post {
                socketOpen = true
                webSocket.send(Protocol.join(code, deviceName))
            }

            override fun onMessage(webSocket: WebSocket, text: String) = post { handle(Protocol.parse(text)) }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = post { socketGone() }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = post { socketGone() }
        })
    }

    private fun socketGone() {
        if (state == State.ENDED) return
        end(if (socketOpen) EndReason.CONNECTION_LOST else EndReason.SERVER_UNREACHABLE)
    }

    private fun handle(message: ServerMessage) {
        if (state == State.ENDED) return
        when (message) {
            ServerMessage.Waiting -> setState(State.WAITING_APPROVAL)
            ServerMessage.Accepted -> {
                setState(State.NEGOTIATING)
                peer.start(iceServers, peerListener)
            }
            is ServerMessage.Rejected ->
                end(if (message.reason == "timeout") EndReason.TIMED_OUT else EndReason.DECLINED)
            ServerMessage.Ended -> end(EndReason.ENDED_BY_RECEIVER)
            ServerMessage.HostLeft -> end(EndReason.RECEIVER_LEFT)
            is ServerMessage.Error -> end(
                when (message.code) {
                    "bad-code" -> EndReason.BAD_CODE
                    "busy" -> EndReason.BUSY
                    "rate-limited" -> EndReason.RATE_LIMITED
                    else -> EndReason.ERROR
                },
            )
            is ServerMessage.Description -> if (negotiating()) peer.setRemoteDescription(message.description)
            is ServerMessage.Candidate -> if (negotiating()) peer.addRemoteCandidate(message.candidate)
            ServerMessage.Unknown -> Unit
        }
    }

    private fun negotiating() = state == State.NEGOTIATING || state == State.LIVE

    private val peerListener = object : Peer.Listener {
        override fun onLocalDescription(description: SessionDescription) = post {
            if (!negotiating()) return@post
            socket?.send(Protocol.description(description))
            offerSent = true
            earlyCandidates.forEach { socket?.send(Protocol.candidate(it)) }
            earlyCandidates.clear()
        }

        override fun onLocalCandidate(candidate: IceCandidate) = post {
            if (!negotiating()) return@post
            if (offerSent) socket?.send(Protocol.candidate(candidate)) else earlyCandidates += candidate
        }

        override fun onConnected() = post {
            if (state == State.NEGOTIATING) setState(State.LIVE)
        }

        override fun onFailed() = post {
            if (state == State.ENDED) return@post
            socket?.send(Protocol.leave())
            end(EndReason.CONNECTION_FAILED)
        }
    }

    private fun end(reason: EndReason) {
        if (state == State.ENDED) return
        state = State.ENDED
        socket?.close(1000, null)
        socket = null
        try {
            peer.close()
        } finally {
            listener.onEnded(reason)
            worker.shutdown() // queued tasks still drain; later posts are ignored
        }
    }
}
