package app.mirrorlink

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import app.mirrorlink.core.SenderSession
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** Launches the real screen on a simulated Android and uses it the way a person would. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MainActivityTest {
    private fun launch(intent: Intent? = null): MainActivity {
        val builder = if (intent == null) {
            Robolectric.buildActivity(MainActivity::class.java)
        } else {
            Robolectric.buildActivity(MainActivity::class.java, intent)
        }
        return builder.setup().get()
    }

    private fun tree(root: View): List<View> =
        if (root is ViewGroup) listOf(root) + (0 until root.childCount).flatMap { tree(root.getChildAt(it)) } else listOf(root)

    private fun Activity.views() = tree(window.decorView)
    private fun Activity.edits() = views().filterIsInstance<EditText>()
    private fun Activity.texts() = views().filterIsInstance<TextView>().map { it.text.toString() }
    private fun Activity.button(textRes: Int) = views().filterIsInstance<Button>().first { it.text == getString(textRes) }

    // serverInput, codeInput, nameInput, in the order the screen builds them
    private fun Activity.serverField() = edits()[0]
    private fun Activity.codeField() = edits()[1]

    @Test
    fun `shows the form with the configured server and no stop button`() {
        val activity = launch()
        assertTrue(activity.texts().contains(activity.getString(R.string.title)))
        assertEquals(View.VISIBLE, activity.button(R.string.action_start).visibility)
        assertEquals(View.GONE, activity.button(R.string.action_stop).visibility)
        val host = BuildConfig.DEFAULT_SERVER.removePrefix("https://").removePrefix("http://")
        assertTrue("server summary should name $host", activity.texts().any { host in it })
    }

    @Test
    fun `formats a typed or pasted code as three plus three digits`() {
        val activity = launch()
        activity.codeField().setText("123456")
        assertEquals("123 456", activity.codeField().text.toString())
        activity.codeField().setText("12-3a4")
        assertEquals("123 4", activity.codeField().text.toString())
    }

    @Test
    fun `a scanned https pairing link fills in the server and code`() {
        val link = Intent(Intent.ACTION_VIEW, Uri.parse("https://mirror.example.com/send?code=123456"))
        val activity = launch(link)
        assertEquals("https://mirror.example.com", activity.serverField().text.toString())
        assertEquals("123 456", activity.codeField().text.toString())
    }

    @Test
    fun `the app deep link from the web page fills in the server and code`() {
        val link = Intent(Intent.ACTION_VIEW, Uri.parse("mirrorlink://join?server=https%3A%2F%2Fmirror.example.com&code=654321"))
        val activity = launch(link)
        assertEquals("https://mirror.example.com", activity.serverField().text.toString())
        assertEquals("654 321", activity.codeField().text.toString())
    }

    @Test
    fun `a link opened while the app is running replaces what was typed`() {
        val activityController = Robolectric.buildActivity(MainActivity::class.java).setup()
        val activity = activityController.get()
        activity.codeField().setText("111111")
        activityController.newIntent(Intent(Intent.ACTION_VIEW, Uri.parse("https://mirror.example.com/send?code=222222")))
        assertEquals("222 222", activity.codeField().text.toString())
    }

    @Test
    fun `tapping start without a code explains what is missing and starts nothing`() {
        val activity = launch()
        activity.button(R.string.action_start).performClick()
        assertTrue(activity.texts().contains(activity.getString(R.string.error_code)))
        assertNull(shadowOf(activity).nextStartedService)
        assertNull(shadowOf(activity).nextStartedActivityForResult)
    }

    @Test
    fun `tapping start with an unusable server explains what is wrong`() {
        val activity = launch()
        activity.serverField().setText("two words")
        activity.codeField().setText("123456")
        activity.button(R.string.action_start).performClick()
        assertTrue(activity.texts().contains(activity.getString(R.string.error_server)))
        assertNull(shadowOf(activity).nextStartedActivityForResult)
    }

    @Test
    fun `start asks for notifications, then screen capture, then starts the mirroring service`() {
        val activity = launch()
        activity.codeField().setText("123456")
        activity.button(R.string.action_start).performClick()

        // Android 13+: the notification permission is asked once, and declining it never blocks mirroring.
        val permission = shadowOf(activity).lastRequestedPermission
        assertNotNull(permission)
        assertTrue(Manifest.permission.POST_NOTIFICATIONS in permission.requestedPermissions)
        activity.onRequestPermissionsResult(permission.requestCode, permission.requestedPermissions, intArrayOf(-1))

        // The system "start recording or casting" screen.
        val capture = shadowOf(activity).nextStartedActivityForResult
        assertNotNull("the screen-capture consent screen should open", capture)
        assertNull("the service must not start before the user consents", shadowOf(activity).nextStartedService)
        val consent = Intent().putExtra("consent", true)
        shadowOf(activity).receiveResult(capture.intent, Activity.RESULT_OK, consent)

        val service = shadowOf(activity).nextStartedService
        assertNotNull("the mirroring service should start after consent", service)
        assertEquals(MirrorService::class.java.name, service.component?.className)
        assertEquals("123456", service.getStringExtra("code"))
        assertEquals(BuildConfig.DEFAULT_SERVER, service.getStringExtra("server"))
        assertEquals("balanced", service.getStringExtra("quality"))
    }

    @Test
    fun `declining screen capture shows a message and starts nothing`() {
        val activity = launch()
        activity.codeField().setText("123456")
        activity.button(R.string.action_start).performClick()
        val permission = shadowOf(activity).lastRequestedPermission
        activity.onRequestPermissionsResult(permission.requestCode, permission.requestedPermissions, intArrayOf(-1))
        val capture = shadowOf(activity).nextStartedActivityForResult
        shadowOf(activity).receiveResult(capture.intent, Activity.RESULT_CANCELED, null)

        assertTrue(activity.texts().contains(activity.getString(R.string.error_capture_denied)))
        assertNull(shadowOf(activity).nextStartedService)
    }

    @Test
    fun `while mirroring the screen offers Stop, and Stop asks the service to stop`() {
        val activity = launch()
        MirrorState.publish(MirrorState.Value.Active(SenderSession.State.LIVE))
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(View.VISIBLE, activity.button(R.string.action_stop).visibility)
        assertEquals(View.GONE, activity.button(R.string.action_start).visibility)
        assertTrue(activity.texts().contains(activity.getString(R.string.status_live)))

        activity.button(R.string.action_stop).performClick()
        assertEquals("app.mirrorlink.action.STOP", shadowOf(activity).nextStartedService.action)

        MirrorState.publish(MirrorState.Value.Idle)
    }

    @Test
    fun `every way a session can end has a readable message`() {
        val activity = launch()
        for (reason in SenderSession.EndReason.entries) {
            MirrorState.publish(MirrorState.Value.Ended(reason))
            shadowOf(Looper.getMainLooper()).idle()
            val status = activity.texts().filter { it.isNotBlank() }
            assertTrue("no message shown for $reason", status.isNotEmpty())
            assertEquals(View.VISIBLE, activity.button(R.string.action_start).visibility)
        }
        MirrorState.publish(MirrorState.Value.Idle)
    }
}
