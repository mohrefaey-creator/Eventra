package app.mirrorlink.core

import org.json.JSONObject

/** One end of the signaling exchange documented in docs/PROTOCOL.md. */
data class IceCandidate(val sdpMid: String?, val sdpMLineIndex: Int, val candidate: String)

data class SessionDescription(val type: String, val sdp: String)

sealed interface ServerMessage {
    data object Waiting : ServerMessage
    data object Accepted : ServerMessage
    data class Rejected(val reason: String) : ServerMessage
    data object Ended : ServerMessage
    data object HostLeft : ServerMessage
    data class Description(val description: SessionDescription) : ServerMessage
    data class Candidate(val candidate: IceCandidate) : ServerMessage
    data class Error(val code: String) : ServerMessage
    data object Unknown : ServerMessage
}

object Protocol {
    fun join(code: String, name: String): String =
        JSONObject().put("type", "join").put("code", code).put("name", name).toString()

    fun leave(): String = JSONObject().put("type", "leave").toString()

    fun description(d: SessionDescription): String = signal(
        JSONObject().put("description", JSONObject().put("type", d.type).put("sdp", d.sdp)),
    )

    fun candidate(c: IceCandidate): String = signal(
        JSONObject().put(
            "candidate",
            JSONObject().put("candidate", c.candidate).put("sdpMid", c.sdpMid ?: JSONObject.NULL).put("sdpMLineIndex", c.sdpMLineIndex),
        ),
    )

    private fun signal(data: JSONObject) = JSONObject().put("type", "signal").put("data", data).toString()

    /** Never throws: anything unreadable becomes [ServerMessage.Unknown]. */
    fun parse(text: String): ServerMessage = try {
        val msg = JSONObject(text)
        when (msg.optString("type")) {
            "waiting" -> ServerMessage.Waiting
            "accepted" -> ServerMessage.Accepted
            "rejected" -> ServerMessage.Rejected(msg.optString("reason", "denied"))
            "ended" -> ServerMessage.Ended
            "host-left" -> ServerMessage.HostLeft
            "error" -> ServerMessage.Error(msg.optString("code", "unknown"))
            "signal" -> parseSignal(msg.optJSONObject("data"))
            else -> ServerMessage.Unknown
        }
    } catch (_: Exception) {
        ServerMessage.Unknown
    }

    private fun parseSignal(data: JSONObject?): ServerMessage {
        data ?: return ServerMessage.Unknown
        data.optJSONObject("description")?.let {
            val type = it.optString("type")
            val sdp = it.optString("sdp")
            if (type.isNotEmpty()) return ServerMessage.Description(SessionDescription(type, sdp))
        }
        data.optJSONObject("candidate")?.let {
            val line = it.optString("candidate")
            if (line.isNotEmpty()) {
                val mid = if (it.isNull("sdpMid")) null else it.optString("sdpMid")
                return ServerMessage.Candidate(IceCandidate(mid, it.optInt("sdpMLineIndex", 0), line))
            }
        }
        return ServerMessage.Unknown
    }
}
