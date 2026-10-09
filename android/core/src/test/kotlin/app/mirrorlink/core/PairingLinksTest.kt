package app.mirrorlink.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

class PairingLinksTest {
    @Test
    fun `parses the link the receiver QR code carries`() {
        assertEquals(
            PairingLink("https://mirror.example.com", "123456"),
            PairingLinks.parse("https://mirror.example.com/send?code=123456"),
        )
    }

    @Test
    fun `keeps a port and tolerates an encoded or spaced code`() {
        assertEquals(
            PairingLink("https://192.168.1.5:3443", "123456"),
            PairingLinks.parse("https://192.168.1.5:3443/send?code=123%20456"),
        )
    }

    @Test
    fun `parses the app deep link the web sender page produces`() {
        assertEquals(
            PairingLink("https://mirror.example.com", "654321"),
            PairingLinks.parse("mirrorlink://join?server=https%3A%2F%2Fmirror.example.com&code=654321"),
        )
    }

    @Test
    fun `rejects anything that is not a pairing link`() {
        listOf(
            "",
            "hello",
            "https://mirror.example.com/send",
            "https://mirror.example.com/send?code=12345",
            "https://mirror.example.com/send?code=abcdef",
            "ftp://mirror.example.com/send?code=123456",
            "mirrorlink://join?code=123456",
            "mirrorlink://join?server=ftp%3A%2F%2Fx&code=123456",
            "not a url at all ?code=123456",
        ).forEach { assertNull(PairingLinks.parse(it), "should reject: '$it'") }
    }

    @Test
    fun `normalizes what a person types into a server origin`() {
        assertEquals("https://mirror.example.com", PairingLinks.normalizeServer("mirror.example.com"))
        assertEquals("https://mirror.example.com", PairingLinks.normalizeServer("  https://mirror.example.com/  "))
        assertEquals("http://10.0.0.5:3000", PairingLinks.normalizeServer("http://10.0.0.5:3000/some/path?x=1"))
        assertEquals("http://[::1]:3000", PairingLinks.normalizeServer("http://[::1]:3000"))
        assertNull(PairingLinks.normalizeServer(""))
        assertNull(PairingLinks.normalizeServer("   "))
        assertNull(PairingLinks.normalizeServer("ftp://mirror.example.com"))
        assertNull(PairingLinks.normalizeServer("https://"))
        assertNull(PairingLinks.normalizeServer("two words"))
    }

    @Test
    fun `normalizes codes to digits`() {
        assertEquals("123456", PairingLinks.normalizeCode("123 456"))
        assertEquals("123456", PairingLinks.normalizeCode("123-456"))
        assertEquals("", PairingLinks.normalizeCode("abc"))
    }

    @Test
    fun `builds the websocket url`() {
        assertEquals("wss://mirror.example.com/ws", PairingLinks.webSocketUrl("https://mirror.example.com"))
        assertEquals("ws://10.0.0.5:3000/ws", PairingLinks.webSocketUrl("http://10.0.0.5:3000"))
    }
}
