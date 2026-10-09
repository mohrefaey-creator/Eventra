package app.mirrorlink

import android.content.Context
import android.os.Build
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PrefsTest {
    private val context: Context get() = RuntimeEnvironment.getApplication()

    @Test
    fun `defaults come from the build and the device`() {
        val prefs = Prefs(context)
        assertEquals(BuildConfig.DEFAULT_SERVER, prefs.server)
        assertEquals(Build.MODEL, prefs.deviceName)
        assertEquals(Quality.BALANCED, prefs.quality)
    }

    @Test
    fun `choices are remembered`() {
        Prefs(context).apply {
            server = "https://mirror.example.com"
            deviceName = "Sam's tablet"
            quality = Quality.SHARP
        }
        val again = Prefs(context)
        assertEquals("https://mirror.example.com", again.server)
        assertEquals("Sam's tablet", again.deviceName)
        assertEquals(Quality.SHARP, again.quality)
    }

    @Test
    fun `an unknown stored quality falls back to balanced`() {
        assertEquals(Quality.BALANCED, Quality.fromKey("nonsense"))
        assertEquals(Quality.BALANCED, Quality.fromKey(null))
        assertEquals(Quality.SAVER, Quality.fromKey("saver"))
    }
}
