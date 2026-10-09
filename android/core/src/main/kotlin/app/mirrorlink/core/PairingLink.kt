package app.mirrorlink.core

import java.net.URI
import java.net.URLDecoder

/** A server plus the pairing code shown on the receiving screen. */
data class PairingLink(val server: String, val code: String)

object PairingLinks {
    /**
     * Understands what the receiver's QR code and the web sender page produce:
     *   https://mirror.example.com/send?code=123456
     *   mirrorlink://join?server=https%3A%2F%2Fmirror.example.com&code=123456
     * Returns null when [text] is neither, or has no valid 6-digit code.
     */
    fun parse(text: String): PairingLink? {
        val uri = try {
            URI(text.trim())
        } catch (_: Exception) {
            return null
        }
        val query = queryOf(uri.rawQuery)
        val code = normalizeCode(query["code"] ?: return null).takeIf { it.length == 6 } ?: return null
        val server = when (uri.scheme?.lowercase()) {
            "https", "http" -> normalizeServer("${uri.scheme}://${uri.rawAuthority}")
            "mirrorlink" -> normalizeServer(query["server"] ?: return null)
            else -> null
        } ?: return null
        return PairingLink(server, code)
    }

    /** Keeps digits only, so "123 456" and "123-456" both work. */
    fun normalizeCode(raw: String): String = raw.filter { it in '0'..'9' }

    /**
     * Turns what a person typed ("mirror.example.com", "https://mirror.example.com/") into a bare
     * origin ("https://mirror.example.com"), or null when it cannot be a server address.
     */
    fun normalizeServer(raw: String): String? {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) return null
        val withScheme = if ("://" in trimmed) trimmed else "https://$trimmed"
        val uri = try {
            URI(withScheme)
        } catch (_: Exception) {
            return null
        }
        val scheme = uri.scheme?.lowercase()
        if (scheme != "https" && scheme != "http") return null
        val host = uri.host?.takeIf { it.isNotEmpty() } ?: return null
        // java.net.URI already returns IPv6 literals with their brackets; keep them as they are.
        val hostPart = if (':' in host && !host.startsWith("[")) "[$host]" else host
        val port = if (uri.port != -1) ":${uri.port}" else ""
        return "$scheme://$hostPart$port"
    }

    /** WebSocket endpoint for a normalized server origin. */
    fun webSocketUrl(server: String): String {
        val ws = if (server.startsWith("https://")) "wss://" else "ws://"
        return ws + server.substringAfter("://") + "/ws"
    }

    private fun queryOf(raw: String?): Map<String, String> {
        if (raw.isNullOrEmpty()) return emptyMap()
        return raw.split('&').mapNotNull { pair ->
            val i = pair.indexOf('=')
            if (i <= 0) null else URLDecoder.decode(pair.substring(0, i), "UTF-8") to URLDecoder.decode(pair.substring(i + 1), "UTF-8")
        }.toMap()
    }
}
