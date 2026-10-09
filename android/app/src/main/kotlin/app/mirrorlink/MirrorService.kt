package app.mirrorlink

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.os.Build
import android.os.IBinder
import app.mirrorlink.core.SenderSession

/**
 * Keeps a mirroring session alive while the app is in the background. Android requires screen capture
 * to run inside a foreground service of type `mediaProjection`, with a visible notification.
 */
class MirrorService : Service() {
    @Volatile
    private var session: SenderSession? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            session?.stop() ?: stopSelf()
            return START_NOT_STICKY
        }

        // Started with startForegroundService(): promoting to the foreground must happen first, on every
        // path, or Android kills the app a few seconds later.
        startForegroundNow()

        val request = intent?.let(::readRequest)
        if (request == null || session != null) {
            if (session == null) stopSelf()
            return START_NOT_STICKY
        }

        val peer = WebRtcPeer(applicationContext, request.projectionData, request.quality) { session?.stop() }
        try {
            peer.beginCapture()
        } catch (e: Exception) {
            failStart(peer)
            return START_NOT_STICKY
        } catch (e: LinkageError) {
            // The native WebRTC library is missing or will not load on this device (for example an x86
            // emulator, which this build does not include). End the session cleanly rather than crash.
            failStart(peer)
            return START_NOT_STICKY
        }
        val newSession = SenderSession(request.server, request.code, request.deviceName, peer, listener)
        session = newSession
        newSession.start()
        return START_NOT_STICKY // the one-time capture permission cannot be restored after a kill
    }

    override fun onDestroy() {
        session?.stop()
        super.onDestroy()
    }

    private val listener = object : SenderSession.Listener {
        override fun onState(state: SenderSession.State) = MirrorState.publish(MirrorState.Value.Active(state))

        override fun onEnded(reason: SenderSession.EndReason) {
            MirrorState.publish(MirrorState.Value.Ended(reason))
            session = null
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    private fun failStart(peer: WebRtcPeer) {
        peer.close()
        MirrorState.publish(MirrorState.Value.Ended(SenderSession.EndReason.ERROR))
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun startForegroundNow() {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, getString(R.string.notification_channel), NotificationManager.IMPORTANCE_LOW),
        )
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun buildNotification(): Notification {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val stop = PendingIntent.getService(
            this,
            1,
            Intent(this, MirrorService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_mirror)
            .setContentTitle(getString(R.string.notification_title))
            .setContentText(getString(R.string.notification_text))
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(
                Notification.Action.Builder(
                    Icon.createWithResource(this, R.drawable.ic_stat_mirror),
                    getString(R.string.notification_stop),
                    stop,
                ).build(),
            )
            .build()
    }

    private class Request(
        val server: String,
        val code: String,
        val deviceName: String,
        val quality: Quality,
        val projectionData: Intent,
    )

    private fun readRequest(intent: Intent): Request? {
        val server = intent.getStringExtra(EXTRA_SERVER) ?: return null
        val code = intent.getStringExtra(EXTRA_CODE) ?: return null
        val data = if (Build.VERSION.SDK_INT >= 33) {
            intent.getParcelableExtra(EXTRA_PROJECTION, Intent::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(EXTRA_PROJECTION)
        } ?: return null
        return Request(
            server = server,
            code = code,
            deviceName = intent.getStringExtra(EXTRA_NAME) ?: Build.MODEL,
            quality = Quality.fromKey(intent.getStringExtra(EXTRA_QUALITY)),
            projectionData = data,
        )
    }

    companion object {
        private const val CHANNEL_ID = "mirroring"
        private const val NOTIFICATION_ID = 1
        private const val ACTION_STOP = "app.mirrorlink.action.STOP"
        private const val EXTRA_SERVER = "server"
        private const val EXTRA_CODE = "code"
        private const val EXTRA_NAME = "name"
        private const val EXTRA_QUALITY = "quality"
        private const val EXTRA_PROJECTION = "projection"

        /** [projectionData] is the Intent the screen-capture consent screen returned. */
        fun startIntent(
            context: Context,
            server: String,
            code: String,
            deviceName: String,
            quality: Quality,
            projectionData: Intent,
        ): Intent = Intent(context, MirrorService::class.java)
            .putExtra(EXTRA_SERVER, server)
            .putExtra(EXTRA_CODE, code)
            .putExtra(EXTRA_NAME, deviceName)
            .putExtra(EXTRA_QUALITY, quality.key)
            .putExtra(EXTRA_PROJECTION, projectionData)

        fun stopIntent(context: Context): Intent = Intent(context, MirrorService::class.java).setAction(ACTION_STOP)
    }
}
