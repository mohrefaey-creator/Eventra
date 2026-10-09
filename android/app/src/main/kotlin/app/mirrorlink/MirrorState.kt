package app.mirrorlink

import android.os.Handler
import android.os.Looper
import app.mirrorlink.core.SenderSession
import java.util.concurrent.CopyOnWriteArraySet

/** How the foreground service tells the screen what the session is doing. Observers run on the main thread. */
object MirrorState {
    sealed interface Value {
        data object Idle : Value
        data class Active(val state: SenderSession.State) : Value
        data class Ended(val reason: SenderSession.EndReason) : Value
    }

    @Volatile
    var current: Value = Value.Idle
        private set

    private val main = Handler(Looper.getMainLooper())
    private val observers = CopyOnWriteArraySet<(Value) -> Unit>()

    fun publish(value: Value) {
        current = value
        main.post { observers.forEach { it(value) } }
    }

    /** Delivers the current value immediately, then every change, until [stopObserving]. */
    fun observe(observer: (Value) -> Unit) {
        observers += observer
        observer(current)
    }

    fun stopObserving(observer: (Value) -> Unit) {
        observers -= observer
    }
}
