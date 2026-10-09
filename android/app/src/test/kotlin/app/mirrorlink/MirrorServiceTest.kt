package app.mirrorlink

import android.content.Context
import android.content.Intent
import app.mirrorlink.core.SenderSession
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MirrorServiceTest {
    private val context: Context get() = RuntimeEnvironment.getApplication()

    @Test
    fun `a stop request with nothing running just stops the service`() {
        val service = Robolectric.buildService(MirrorService::class.java).create().get()
        service.onStartCommand(MirrorService.stopIntent(context), 0, 1)
        assertTrue(shadowOf(service).isStoppedBySelf)
    }

    @Test
    fun `a malformed start request still goes foreground first, as Android requires, then stops`() {
        val service = Robolectric.buildService(MirrorService::class.java).create().get()
        service.onStartCommand(Intent(context, MirrorService::class.java), 0, 1)
        assertNotNull("must call startForeground or Android kills the app", shadowOf(service).lastForegroundNotification)
        assertTrue(shadowOf(service).isStoppedBySelf)
    }

    @Test
    fun `the foreground notification offers a Stop action`() {
        val service = Robolectric.buildService(MirrorService::class.java).create().get()
        service.onStartCommand(Intent(context, MirrorService::class.java), 0, 1)
        val notification = shadowOf(service).lastForegroundNotification
        assertEquals(1, notification.actions.size)
        assertEquals(context.getString(R.string.notification_stop), notification.actions[0].title.toString())
    }

    @Test
    fun `when the native WebRTC library cannot load the session ends with an error instead of crashing`() {
        // Robolectric has no libjingle_peerconnection_so, which is exactly the "wrong CPU" failure on a real device.
        val service = Robolectric.buildService(MirrorService::class.java).create().get()
        val start = MirrorService.startIntent(context, "https://mirror.example.com", "123456", "Test tablet", Quality.BALANCED, Intent())
        service.onStartCommand(start, 0, 1)

        assertEquals(MirrorState.Value.Ended(SenderSession.EndReason.ERROR), MirrorState.current)
        assertTrue(shadowOf(service).isStoppedBySelf)
        MirrorState.publish(MirrorState.Value.Idle)
    }
}
