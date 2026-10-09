package app.mirrorlink.core

import org.json.JSONObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

/** The JSON shapes here are exactly what public/send.js and public/receive.js exchange. */
class ProtocolTest {
    private fun json(text: String) = JSONObject(text)

    @Test
    fun `join and leave match the wire protocol`() {
        val join = json(Protocol.join("123456", "Sam's tablet"))
        assertEquals("join", join.getString("type"))
        assertEquals("123456", join.getString("code"))
        assertEquals("Sam's tablet", join.getString("name"))
        assertEquals("leave", json(Protocol.leave()).getString("type"))
    }

    @Test
    fun `an offer is wrapped the way the browser expects`() {
        val msg = json(Protocol.description(SessionDescription("offer", "v=0\r\n")))
        assertEquals("signal", msg.getString("type"))
        val d = msg.getJSONObject("data").getJSONObject("description")
        assertEquals("offer", d.getString("type"))
        assertEquals("v=0\r\n", d.getString("sdp"))
    }

    @Test
    fun `a candidate carries the three fields addIceCandidate needs`() {
        val c = json(Protocol.candidate(IceCandidate("0", 1, "candidate:1 1 udp 1 10.0.0.2 5000 typ host")))
            .getJSONObject("data").getJSONObject("candidate")
        assertEquals("candidate:1 1 udp 1 10.0.0.2 5000 typ host", c.getString("candidate"))
        assertEquals("0", c.getString("sdpMid"))
        assertEquals(1, c.getInt("sdpMLineIndex"))
    }

    @Test
    fun `a candidate without an mid survives a round trip`() {
        val sent = Protocol.candidate(IceCandidate(null, 0, "candidate:9"))
        val back = (Protocol.parse(sent) as ServerMessage.Candidate).candidate
        assertNull(back.sdpMid)
        assertEquals(IceCandidate(null, 0, "candidate:9"), back)
    }

    @Test
    fun `parses every message the server and receiver can send`() {
        assertEquals(ServerMessage.Waiting, Protocol.parse("""{"type":"waiting"}"""))
        assertEquals(ServerMessage.Accepted, Protocol.parse("""{"type":"accepted"}"""))
        assertEquals(ServerMessage.Rejected("timeout"), Protocol.parse("""{"type":"rejected","reason":"timeout"}"""))
        assertEquals(ServerMessage.Rejected("denied"), Protocol.parse("""{"type":"rejected"}"""))
        assertEquals(ServerMessage.Ended, Protocol.parse("""{"type":"ended"}"""))
        assertEquals(ServerMessage.HostLeft, Protocol.parse("""{"type":"host-left"}"""))
        assertEquals(ServerMessage.Error("bad-code"), Protocol.parse("""{"type":"error","code":"bad-code"}"""))
        assertEquals(
            ServerMessage.Description(SessionDescription("answer", "v=0")),
            Protocol.parse("""{"type":"signal","data":{"description":{"type":"answer","sdp":"v=0"}}}"""),
        )
        assertEquals(
            ServerMessage.Candidate(IceCandidate("0", 0, "candidate:1")),
            Protocol.parse("""{"type":"signal","data":{"candidate":{"candidate":"candidate:1","sdpMid":"0","sdpMLineIndex":0}}}"""),
        )
    }

    @Test
    fun `garbage never throws`() {
        listOf("", "not json", "[]", "{}", """{"type":5}""", """{"type":"signal"}""", """{"type":"signal","data":{}}""", """{"type":"nope"}""")
            .forEach { assertEquals(ServerMessage.Unknown, Protocol.parse(it), "input: '$it'") }
    }
}
