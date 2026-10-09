package app.mirrorlink.core

import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject

data class IceServer(val urls: List<String>, val username: String? = null, val credential: String? = null)

/** What the server tells a client before pairing (GET /api/info). */
data class ServerInfo(val iceServers: List<IceServer>) {
    companion object {
        val FALLBACK = ServerInfo(listOf(IceServer(listOf("stun:stun.l.google.com:19302"))))

        fun parse(json: String): ServerInfo {
            val servers = JSONObject(json).optJSONArray("iceServers") ?: return FALLBACK
            val out = (0 until servers.length()).mapNotNull { i ->
                val s = servers.optJSONObject(i) ?: return@mapNotNull null
                // RTCIceServer.urls may be a string or an array of strings.
                val urls = when (val u = s.opt("urls")) {
                    is String -> listOf(u)
                    is JSONArray -> (0 until u.length()).map { u.getString(it) }
                    else -> emptyList()
                }
                if (urls.isEmpty()) null
                else IceServer(urls, s.optString("username").ifEmpty { null }, s.optString("credential").ifEmpty { null })
            }
            return if (out.isEmpty()) FALLBACK else ServerInfo(out)
        }

        /** Blocking: call off the main thread. Throws on network or HTTP errors. */
        fun fetch(client: OkHttpClient, server: String): ServerInfo {
            val request = Request.Builder().url("$server/api/info").build()
            client.newCall(request).execute().use { response ->
                check(response.isSuccessful) { "HTTP ${response.code}" }
                return parse(response.body!!.string())
            }
        }
    }
}
