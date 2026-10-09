package app.mirrorlink.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class ServerInfoTest {
    @Test
    fun `reads string and array urls and TURN credentials`() {
        val info = ServerInfo.parse(
            """{"iceServers":[
                 {"urls":"stun:stun.example.com:3478"},
                 {"urls":["turn:turn.example.com:3478","turns:turn.example.com:5349"],"username":"u","credential":"p"}
               ],"senderOrigins":[]}""",
        )
        assertEquals(
            listOf(
                IceServer(listOf("stun:stun.example.com:3478")),
                IceServer(listOf("turn:turn.example.com:3478", "turns:turn.example.com:5349"), "u", "p"),
            ),
            info.iceServers,
        )
    }

    @Test
    fun `falls back to a public STUN server when the list is missing or unusable`() {
        assertEquals(ServerInfo.FALLBACK, ServerInfo.parse("{}"))
        assertEquals(ServerInfo.FALLBACK, ServerInfo.parse("""{"iceServers":[]}"""))
        assertEquals(ServerInfo.FALLBACK, ServerInfo.parse("""{"iceServers":[{"nourls":1}]}"""))
    }
}
