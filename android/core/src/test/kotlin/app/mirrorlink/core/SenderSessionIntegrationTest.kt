package app.mirrorlink.core

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.junit.jupiter.api.fail
import java.io.File
import java.io.IOException
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.ServerSocket
import java.net.URL
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

private const val WAIT_MS = 8_000L

/**
 * Drives [SenderSession] against the real Node server in this repository, with a scripted receiver
 * on the other side. This is what proves the Kotlin client and the web receiver speak the same protocol.
 * Skipped (not failed) when `node` is not installed.
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class SenderSessionIntegrationTest {
    private var node: NodeServer? = null
    private val origin get() = node!!.origin

    @BeforeAll
    fun startServer() {
        node = NodeServer.startOrNull()
        assumeTrue(node != null, "node (or the repo's server/) is not available")
    }

    @AfterAll
    fun stopServer() {
        node?.close()
    }

    private fun newSession(code: String, peer: FakePeer, recorder: Recorder, server: String = origin) =
        SenderSession(server, code, "Test Samsung", peer, recorder)

    @Test
    fun `pairs, negotiates, goes live and stops cleanly`() {
        val receiver = FakeReceiver(origin).connect()
        val code = receiver.host()
        val peer = FakePeer()
        val rec = Recorder()
        val session = newSession(code, peer, rec)
        session.start()

        val request = receiver.expect("join-request")
        assertEquals("Test Samsung", request.getString("name"))
        val peerId = request.getString("peerId")
        rec.awaitState(SenderSession.State.WAITING_APPROVAL)

        receiver.send(JSONObject().put("type", "accept").put("peerId", peerId))
        rec.awaitState(SenderSession.State.NEGOTIATING)
        assertTrue(peer.started.await(WAIT_MS, TimeUnit.MILLISECONDS))
        assertTrue(peer.iceServers.isNotEmpty(), "ICE servers should come from /api/info")

        // The offer and candidate reach the receiver in the shape public/receive.js expects.
        val offer = receiver.expect("signal")
        assertEquals(peerId, offer.getString("peerId"))
        val description = offer.getJSONObject("data").getJSONObject("description")
        assertEquals("offer", description.getString("type"))
        assertEquals("v=0 fake offer", description.getString("sdp"))
        val candidate = receiver.expect("signal").getJSONObject("data").getJSONObject("candidate")
        assertEquals("0", candidate.getString("sdpMid"))
        assertTrue(candidate.getString("candidate").startsWith("candidate:"))

        // The receiver's answer and candidates reach the peer.
        receiver.send(
            JSONObject().put("type", "signal").put(
                "data",
                JSONObject().put("description", JSONObject().put("type", "answer").put("sdp", "v=0 fake answer")),
            ),
        )
        assertEquals(SessionDescription("answer", "v=0 fake answer"), peer.remoteDescriptions.poll(WAIT_MS, TimeUnit.MILLISECONDS))
        receiver.send(
            JSONObject().put("type", "signal").put(
                "data",
                JSONObject().put(
                    "candidate",
                    JSONObject().put("candidate", "candidate:2 1 udp 1 10.0.0.9 6000 typ host").put("sdpMid", "0").put("sdpMLineIndex", 0),
                ),
            ),
        )
        assertEquals(
            IceCandidate("0", 0, "candidate:2 1 udp 1 10.0.0.9 6000 typ host"),
            peer.remoteCandidates.poll(WAIT_MS, TimeUnit.MILLISECONDS),
        )

        peer.listener!!.onConnected()
        rec.awaitState(SenderSession.State.LIVE)

        session.stop()
        assertEquals(SenderSession.EndReason.STOPPED, rec.awaitEnd())
        assertEquals(peerId, receiver.expect("peer-left").getString("peerId"))
        assertTrue(peer.closeCount.get() >= 1)
        receiver.close()
    }

    @Test
    fun `a candidate found before the offer is held back until the offer is sent`() {
        val receiver = FakeReceiver(origin).connect()
        val code = receiver.host()
        val peer = FakePeer(candidateFirst = true)
        val rec = Recorder()
        newSession(code, peer, rec).start()
        val peerId = receiver.expect("join-request").getString("peerId")
        receiver.send(JSONObject().put("type", "accept").put("peerId", peerId))

        val first = receiver.expect("signal").getJSONObject("data")
        assertTrue(first.has("description"), "the offer must arrive before any candidate")
        assertTrue(receiver.expect("signal").getJSONObject("data").has("candidate"))

        peer.listener!!.onFailed()
        rec.awaitEnd()
        receiver.close()
    }

    @Test
    fun `a wrong code ends the session as BAD_CODE`() {
        val rec = Recorder()
        newSession("000000", FakePeer(), rec).start()
        assertEquals(SenderSession.EndReason.BAD_CODE, rec.awaitEnd())
    }

    @Test
    fun `a declined request ends as DECLINED and never starts the peer`() {
        val receiver = FakeReceiver(origin).connect()
        val code = receiver.host()
        val peer = FakePeer()
        val rec = Recorder()
        newSession(code, peer, rec).start()
        val peerId = receiver.expect("join-request").getString("peerId")
        receiver.send(JSONObject().put("type", "reject").put("peerId", peerId))
        assertEquals(SenderSession.EndReason.DECLINED, rec.awaitEnd())
        assertEquals(0, peer.startCount.get())
        receiver.close()
    }

    @Test
    fun `the receiver ending the session is reported`() {
        val receiver = FakeReceiver(origin).connect()
        val code = receiver.host()
        val rec = Recorder()
        newSession(code, FakePeer(), rec).start()
        val peerId = receiver.expect("join-request").getString("peerId")
        receiver.send(JSONObject().put("type", "accept").put("peerId", peerId))
        rec.awaitState(SenderSession.State.NEGOTIATING)
        receiver.send(JSONObject().put("type", "end"))
        assertEquals(SenderSession.EndReason.ENDED_BY_RECEIVER, rec.awaitEnd())
        receiver.close()
    }

    @Test
    fun `the receiver disappearing is reported`() {
        val receiver = FakeReceiver(origin).connect()
        val code = receiver.host()
        val rec = Recorder()
        newSession(code, FakePeer(), rec).start()
        receiver.expect("join-request")
        receiver.close()
        assertEquals(SenderSession.EndReason.RECEIVER_LEFT, rec.awaitEnd())
    }

    @Test
    fun `a peer connection failure leaves the receiver informed`() {
        val receiver = FakeReceiver(origin).connect()
        val code = receiver.host()
        val peer = FakePeer()
        val rec = Recorder()
        newSession(code, peer, rec).start()
        val peerId = receiver.expect("join-request").getString("peerId")
        receiver.send(JSONObject().put("type", "accept").put("peerId", peerId))
        assertTrue(peer.started.await(WAIT_MS, TimeUnit.MILLISECONDS))
        peer.listener!!.onFailed()
        assertEquals(SenderSession.EndReason.CONNECTION_FAILED, rec.awaitEnd())
        receiver.expect("peer-left")
        receiver.close()
    }

    @Test
    fun `stopping while waiting for approval withdraws the request`() {
        val receiver = FakeReceiver(origin).connect()
        val code = receiver.host()
        val rec = Recorder()
        val session = newSession(code, FakePeer(), rec)
        session.start()
        receiver.expect("join-request")
        rec.awaitState(SenderSession.State.WAITING_APPROVAL)
        session.stop()
        assertEquals(SenderSession.EndReason.STOPPED, rec.awaitEnd())
        receiver.expect("peer-left")
        receiver.close()
    }

    @Test
    fun `an unreachable server ends as SERVER_UNREACHABLE`() {
        val rec = Recorder()
        newSession("123456", FakePeer(), rec, server = "http://127.0.0.1:1").start()
        assertEquals(SenderSession.EndReason.SERVER_UNREACHABLE, rec.awaitEnd())
    }

    @Test
    fun `a second start is ignored and stop after the end is harmless`() {
        val receiver = FakeReceiver(origin).connect()
        val code = receiver.host()
        val rec = Recorder()
        val session = newSession(code, FakePeer(), rec)
        session.start()
        session.start()
        receiver.expect("join-request")
        session.stop()
        assertEquals(SenderSession.EndReason.STOPPED, rec.awaitEnd())
        session.stop()
        assertEquals(1, rec.endCount.get())
        receiver.close()
    }
}

// ------------------------------------------------------------------ test doubles

private class Recorder : SenderSession.Listener {
    private val states = CopyOnWriteArrayList<SenderSession.State>()
    private val ended = CompletableFuture<SenderSession.EndReason>()
    val endCount = AtomicInteger()

    override fun onState(state: SenderSession.State) {
        states += state
    }

    override fun onEnded(reason: SenderSession.EndReason) {
        endCount.incrementAndGet()
        ended.complete(reason)
    }

    fun awaitEnd(): SenderSession.EndReason = try {
        ended.get(WAIT_MS, TimeUnit.MILLISECONDS)
    } catch (e: Exception) {
        fail("session did not end; states seen: $states")
    }

    fun awaitState(state: SenderSession.State) {
        val deadline = System.currentTimeMillis() + WAIT_MS
        while (state !in states) {
            if (System.currentTimeMillis() > deadline) fail("never reached $state; states seen: $states")
            Thread.sleep(20)
        }
    }
}

private class FakePeer(private val candidateFirst: Boolean = false) : Peer {
    @Volatile var listener: Peer.Listener? = null
    @Volatile var iceServers: List<IceServer> = emptyList()
    val started = CountDownLatch(1)
    val startCount = AtomicInteger()
    val closeCount = AtomicInteger()
    val remoteDescriptions = LinkedBlockingQueue<SessionDescription>()
    val remoteCandidates = LinkedBlockingQueue<IceCandidate>()

    override fun start(iceServers: List<IceServer>, listener: Peer.Listener) {
        this.iceServers = iceServers
        this.listener = listener
        startCount.incrementAndGet()
        started.countDown()
        val offer = { listener.onLocalDescription(SessionDescription("offer", "v=0 fake offer")) }
        val candidate = { listener.onLocalCandidate(IceCandidate("0", 0, "candidate:1 1 udp 2122260223 192.168.1.20 54321 typ host")) }
        if (candidateFirst) { candidate(); offer() } else { offer(); candidate() }
    }

    override fun setRemoteDescription(description: SessionDescription) {
        remoteDescriptions.add(description)
    }

    override fun addRemoteCandidate(candidate: IceCandidate) {
        remoteCandidates.add(candidate)
    }

    override fun close() {
        closeCount.incrementAndGet()
    }
}

/** A scripted receiver: speaks the host side of the protocol exactly like public/receive.js. */
private class FakeReceiver(private val origin: String) {
    private val inbox = LinkedBlockingQueue<JSONObject>()
    private val client = OkHttpClient()
    private lateinit var socket: WebSocket

    fun connect(): FakeReceiver {
        val open = CountDownLatch(1)
        socket = client.newWebSocket(
            Request.Builder().url(PairingLinks.webSocketUrl(origin)).build(),
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) = open.countDown()
                override fun onMessage(webSocket: WebSocket, text: String) {
                    inbox.add(JSONObject(text))
                }
            },
        )
        assertTrue(open.await(WAIT_MS, TimeUnit.MILLISECONDS), "receiver could not connect")
        return this
    }

    fun send(message: JSONObject) {
        assertTrue(socket.send(message.toString()))
    }

    fun host(): String {
        send(JSONObject().put("type", "host"))
        return expect("hosted").getString("code")
    }

    /** Next message of [type]; earlier messages of other types are skipped. */
    fun expect(type: String): JSONObject {
        val deadline = System.currentTimeMillis() + WAIT_MS
        while (true) {
            val remaining = deadline - System.currentTimeMillis()
            val msg = inbox.poll(maxOf(remaining, 1), TimeUnit.MILLISECONDS) ?: fail("timed out waiting for '$type'")
            if (msg.getString("type") == type) return msg
        }
    }

    fun close() {
        socket.close(1000, null)
        client.dispatcher.executorService.shutdown()
    }
}

private class NodeServer private constructor(private val process: Process, port: Int) : AutoCloseable {
    val origin = "http://127.0.0.1:$port"

    override fun close() {
        process.destroy()
        if (!process.waitFor(5, TimeUnit.SECONDS)) process.destroyForcibly()
    }

    companion object {
        /** null = cannot run here (no node / no server directory). Throws if the server starts but never answers. */
        fun startOrNull(): NodeServer? {
            val root = File("../..").canonicalFile // tests run in android/core
            if (!File(root, "server/index.js").exists()) return null
            val port = ServerSocket(0).use { it.localPort }
            val builder = ProcessBuilder("node", "server/index.js").directory(root).redirectErrorStream(true)
            builder.environment().putAll(mapOf("PORT" to "$port", "TLS" to "off", "HOST" to "127.0.0.1"))
            val process = try {
                builder.start()
            } catch (_: IOException) {
                return null
            }
            Thread { process.inputStream.copyTo(OutputStream.nullOutputStream()) }.apply { isDaemon = true }.start()

            val deadline = System.currentTimeMillis() + 15_000
            while (System.currentTimeMillis() < deadline) {
                try {
                    val conn = URL("http://127.0.0.1:$port/api/info").openConnection() as HttpURLConnection
                    conn.connectTimeout = 500
                    conn.readTimeout = 500
                    if (conn.responseCode == 200) return NodeServer(process, port)
                } catch (_: IOException) {
                    // not up yet
                }
                Thread.sleep(150)
            }
            process.destroyForcibly()
            throw AssertionError("the Node server started but never answered on port $port")
        }
    }
}
