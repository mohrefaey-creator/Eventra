package app.mirrorlink

import android.content.Context
import android.os.Build

/** Video settings per quality choice. Keys are stored, so never rename them. */
enum class Quality(val key: String, val longEdge: Int, val fps: Int, val maxBitrateBps: Int, val labelRes: Int) {
    BALANCED("balanced", 1280, 30, 4_000_000, R.string.quality_balanced),
    SHARP("sharp", 1920, 30, 8_000_000, R.string.quality_sharp),
    SAVER("saver", 960, 20, 1_500_000, R.string.quality_saver),
    ;

    companion object {
        fun fromKey(key: String?): Quality = entries.firstOrNull { it.key == key } ?: BALANCED
    }
}

/** Small things worth remembering between launches. */
class Prefs(context: Context) {
    private val prefs = context.getSharedPreferences("mirrorlink", Context.MODE_PRIVATE)

    var server: String
        get() = prefs.getString("server", null) ?: BuildConfig.DEFAULT_SERVER
        set(value) = prefs.edit().putString("server", value).apply()

    var deviceName: String
        get() = prefs.getString("name", null) ?: Build.MODEL
        set(value) = prefs.edit().putString("name", value).apply()

    var quality: Quality
        get() = Quality.fromKey(prefs.getString("quality", null))
        set(value) = prefs.edit().putString("quality", value.key).apply()

    /** The notification permission is asked for once; declining it never blocks mirroring. */
    var askedNotifications: Boolean
        get() = prefs.getBoolean("asked_notifications", false)
        set(value) = prefs.edit().putBoolean("asked_notifications", value).apply()
}
