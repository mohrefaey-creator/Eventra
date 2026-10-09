package app.mirrorlink

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Rect
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.text.Editable
import android.text.InputFilter
import android.text.InputType
import android.text.TextWatcher
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.TextView
import app.mirrorlink.core.PairingLinks
import app.mirrorlink.core.SenderSession.EndReason
import app.mirrorlink.core.SenderSession.State

/**
 * The whole UI: enter the code, tap Start. Everything else (capture, WebRTC, pairing) happens in
 * [MirrorService] so mirroring continues when this screen is closed.
 */
class MainActivity : Activity() {
    private lateinit var prefs: Prefs
    private lateinit var serverSummary: TextView
    private lateinit var serverInput: EditText
    private lateinit var changeServer: Button
    private lateinit var codeInput: EditText
    private lateinit var nameInput: EditText
    private lateinit var qualitySpinner: Spinner
    private lateinit var startButton: Button
    private lateinit var stopButton: Button
    private lateinit var status: TextView
    private lateinit var form: List<View>
    private var normalStatusColor = Color.GRAY

    private class StartRequest(val server: String, val code: String, val name: String, val quality: Quality)

    private var pending: StartRequest? = null
    private val observer: (MirrorState.Value) -> Unit = ::render

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        setContentView(buildUi())
        applyLink(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        applyLink(intent)
    }

    override fun onStart() {
        super.onStart()
        MirrorState.observe(observer)
    }

    override fun onStop() {
        super.onStop()
        MirrorState.stopObserving(observer)
    }

    // ------------------------------------------------------------------- flow

    /** A scanned QR code or the web page's "open the app" button arrives as a link: fill the form from it. */
    private fun applyLink(intent: Intent?) {
        val link = intent?.data?.let { PairingLinks.parse(it.toString()) } ?: return
        serverInput.setText(link.server)
        codeInput.setText(formatCode(link.code))
        showServer()
        // A new pairing starts from a clean status, not the last session's "Stopped sharing."
        if (MirrorState.current !is MirrorState.Value.Active) MirrorState.publish(MirrorState.Value.Idle)
    }

    private fun onStartTapped() {
        val server = PairingLinks.normalizeServer(serverInput.text.toString())
        if (server == null) {
            serverInput.visibility = View.VISIBLE
            showStatus(getString(R.string.error_server), isError = true)
            return
        }
        val code = PairingLinks.normalizeCode(codeInput.text.toString())
        if (code.length != 6) {
            showStatus(getString(R.string.error_code), isError = true)
            codeInput.requestFocus()
            return
        }
        val name = nameInput.text.toString().trim().ifEmpty { Build.MODEL }
        val quality = Quality.entries[qualitySpinner.selectedItemPosition]
        prefs.server = server
        prefs.deviceName = name
        prefs.quality = quality
        pending = StartRequest(server, code, name, quality)

        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED &&
            !prefs.askedNotifications
        ) {
            // Without it the "mirroring" notification is hidden, but mirroring still works.
            prefs.askedNotifications = true
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIFICATIONS)
        } else {
            requestCapture()
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_NOTIFICATIONS) requestCapture()
    }

    @Suppress("DEPRECATION") // the AndroidX replacement would add a dependency for no gain here
    private fun requestCapture() {
        val manager = getSystemService(MediaProjectionManager::class.java)
        startActivityForResult(manager.createScreenCaptureIntent(), REQUEST_CAPTURE)
    }

    @Suppress("DEPRECATION")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQUEST_CAPTURE) return
        val request = pending ?: return
        pending = null
        if (resultCode == RESULT_OK && data != null) {
            startForegroundService(
                MirrorService.startIntent(this, request.server, request.code, request.name, request.quality, data),
            )
        } else {
            showStatus(getString(R.string.error_capture_denied), isError = true)
        }
    }

    // ----------------------------------------------------------------- display

    private fun render(value: MirrorState.Value) {
        when (value) {
            MirrorState.Value.Idle -> {
                setBusy(false)
                showStatus(getString(R.string.status_idle))
            }
            is MirrorState.Value.Active -> {
                setBusy(true)
                showStatus(
                    getString(
                        when (value.state) {
                            State.IDLE, State.CONNECTING -> R.string.status_connecting
                            State.WAITING_APPROVAL -> R.string.status_waiting
                            State.NEGOTIATING -> R.string.status_negotiating
                            State.LIVE -> R.string.status_live
                            State.ENDED -> R.string.status_idle
                        },
                    ),
                )
            }
            is MirrorState.Value.Ended -> {
                setBusy(false)
                val (text, isError) = endMessage(value.reason)
                showStatus(getString(text), isError)
            }
        }
    }

    private fun endMessage(reason: EndReason): Pair<Int, Boolean> = when (reason) {
        EndReason.STOPPED -> R.string.end_stopped to false
        EndReason.ENDED_BY_RECEIVER -> R.string.end_by_receiver to false
        EndReason.DECLINED -> R.string.end_declined to true
        EndReason.TIMED_OUT -> R.string.end_timed_out to true
        EndReason.RECEIVER_LEFT -> R.string.end_receiver_left to true
        EndReason.BAD_CODE -> R.string.end_bad_code to true
        EndReason.BUSY -> R.string.end_busy to true
        EndReason.RATE_LIMITED -> R.string.end_rate_limited to true
        EndReason.SERVER_UNREACHABLE -> R.string.end_unreachable to true
        EndReason.CONNECTION_LOST -> R.string.end_lost to true
        EndReason.CONNECTION_FAILED -> R.string.end_failed to true
        EndReason.ERROR -> R.string.end_error to true
    }

    private fun setBusy(busy: Boolean) {
        startButton.visibility = if (busy) View.GONE else View.VISIBLE
        stopButton.visibility = if (busy) View.VISIBLE else View.GONE
        form.forEach { it.isEnabled = !busy }
    }

    private fun showStatus(text: String, isError: Boolean = false) {
        status.text = text
        status.setTextColor(if (isError) errorColor() else normalStatusColor)
    }

    private fun errorColor(): Int {
        val night = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
        return if (night) Color.parseColor("#FF6B6B") else Color.parseColor("#C62828")
    }

    private fun showServer() {
        serverSummary.text = getString(R.string.label_server) + ": " +
            serverInput.text.toString().removePrefix("https://").removePrefix("http://")
    }

    // ---------------------------------------------------------------------- UI

    private fun buildUi(): View {
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(32), dp(24), dp(32))
        }

        column.addView(TextView(this).apply {
            text = getString(R.string.title)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 28f)
            setTypeface(typeface, android.graphics.Typeface.BOLD)
            accessibilityHeading()
        })
        column.addView(TextView(this).apply {
            text = getString(R.string.lead)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            alpha = 0.75f
            setPadding(0, dp(8), 0, dp(24))
        })

        // Server: shown as a quiet summary; "Change" reveals the field. Most people never touch it.
        serverInput = EditText(this).apply {
            setText(prefs.server)
            hint = getString(R.string.hint_server)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            visibility = View.GONE
            contentDescription = getString(R.string.label_server)
        }
        serverSummary = TextView(this).apply { setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f); alpha = 0.75f }
        changeServer = Button(this).apply {
            text = getString(R.string.action_change_server)
            setOnClickListener {
                serverInput.visibility = View.VISIBLE
                serverInput.requestFocus()
            }
        }
        column.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(serverSummary, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(changeServer)
        })
        column.addView(serverInput, matchWidth(bottom = 16))
        showServer()

        column.addView(label(R.string.label_code))
        codeInput = EditText(this).apply {
            hint = getString(R.string.hint_code)
            inputType = InputType.TYPE_CLASS_NUMBER
            filters = arrayOf(InputFilter.LengthFilter(7))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 32f)
            gravity = Gravity.CENTER
            letterSpacing = 0.2f
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
            addTextChangedListener(CodeFormatter(this))
        }
        column.addView(codeInput, matchWidth(bottom = 16))

        column.addView(label(R.string.label_name))
        nameInput = EditText(this).apply {
            setText(prefs.deviceName)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_WORDS
            filters = arrayOf(InputFilter.LengthFilter(40))
        }
        column.addView(nameInput, matchWidth(bottom = 16))

        column.addView(label(R.string.label_quality))
        qualitySpinner = Spinner(this).apply {
            adapter = ArrayAdapter(
                this@MainActivity,
                android.R.layout.simple_spinner_item,
                Quality.entries.map { getString(it.labelRes) },
            ).also { it.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item) }
            setSelection(Quality.entries.indexOf(prefs.quality))
        }
        column.addView(qualitySpinner, matchWidth(bottom = 24))

        startButton = Button(this).apply {
            text = getString(R.string.action_start)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
            minimumHeight = dp(56)
            setOnClickListener { onStartTapped() }
        }
        stopButton = Button(this).apply {
            text = getString(R.string.action_stop)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
            minimumHeight = dp(56)
            visibility = View.GONE
            setOnClickListener { startService(MirrorService.stopIntent(this@MainActivity)) }
        }
        column.addView(startButton, matchWidth())
        column.addView(stopButton, matchWidth())

        status = TextView(this).apply {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            setPadding(0, dp(16), 0, 0)
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }
        normalStatusColor = status.textColors.defaultColor
        column.addView(status, matchWidth())

        form = listOf(codeInput, nameInput, qualitySpinner, serverInput, changeServer)

        // Since Android 15 apps draw edge to edge; keep the form clear of the system bars.
        return ScrollView(this).apply {
            isFillViewport = true
            addView(column)
            setOnApplyWindowInsetsListener { view, insets ->
                val bars = systemBars(insets)
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
                insets
            }
        }
    }

    @Suppress("DEPRECATION")
    private fun systemBars(insets: WindowInsets): Rect =
        if (Build.VERSION.SDK_INT >= 30) {
            insets.getInsets(WindowInsets.Type.systemBars()).let { Rect(it.left, it.top, it.right, it.bottom) }
        } else {
            Rect(insets.systemWindowInsetLeft, insets.systemWindowInsetTop, insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
        }

    private fun label(textRes: Int) = TextView(this).apply {
        text = getString(textRes)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
        setTypeface(typeface, android.graphics.Typeface.BOLD)
        setPadding(0, 0, 0, dp(4))
    }

    /** Lets screen readers jump between sections. The API only exists from Android 9; older versions skip it. */
    private fun TextView.accessibilityHeading() {
        if (Build.VERSION.SDK_INT >= 28) isAccessibilityHeading = true
    }

    private fun matchWidth(bottom: Int = 0) = LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT,
    ).apply { bottomMargin = dp(bottom) }

    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

    private fun formatCode(digits: String) = if (digits.length > 3) "${digits.take(3)} ${digits.drop(3)}" else digits

    /** Shows the code as "123 456" while it is typed or pasted. */
    private inner class CodeFormatter(private val field: EditText) : TextWatcher {
        private var editing = false

        override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
        override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit

        override fun afterTextChanged(s: Editable?) {
            if (editing) return
            editing = true
            val formatted = formatCode(PairingLinks.normalizeCode(s.toString()).take(6))
            if (formatted != s.toString()) {
                field.setText(formatted)
                field.setSelection(formatted.length)
            }
            editing = false
        }
    }

    private companion object {
        const val REQUEST_CAPTURE = 1
        const val REQUEST_NOTIFICATIONS = 2
    }
}
