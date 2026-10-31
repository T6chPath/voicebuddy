package com.voicebuddy.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.SystemClock
import android.provider.Settings
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.View
import android.widget.ImageButton
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import java.util.Locale

class MainActivity : AppCompatActivity(), TextToSpeech.OnInitListener {

    companion object {
        const val ACTION_LISTEN = "com.voicebuddy.app.LISTEN"
        /** Started from the floating button while another app was open: go back to it afterwards. */
        const val EXTRA_FROM_BUTTON = "from_button"
        /** A tap within this time after opening the app counts as the "second tap" of a double tap. */
        private const val SECOND_TAP_WINDOW_MS = 1500L
    }

    private lateinit var status: TextView
    private lateinit var heard: TextView
    private lateinit var autoTapHint: TextView
    private var recognizer: SpeechRecognizer? = null
    private var tts: TextToSpeech? = null
    private lateinit var executor: ActionExecutor
    private lateinit var gestures: GestureDetector
    private var listening = false
    private var secondTapUntil = 0L
    private var returnAfter = false

    private val permissions = arrayOf(
        Manifest.permission.RECORD_AUDIO,
        Manifest.permission.READ_CONTACTS,
        Manifest.permission.CALL_PHONE,
        Manifest.permission.READ_PHONE_STATE
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        status = findViewById(R.id.statusText)
        heard = findViewById(R.id.heardText)
        autoTapHint = findViewById(R.id.autoTapHint)
        executor = ActionExecutor(this)
        tts = TextToSpeech(this, this)

        findViewById<ImageButton>(R.id.micButton).setOnClickListener { startListening() }
        autoTapHint.setOnClickListener { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }

        gestures = GestureDetector(this, object : GestureDetector.SimpleOnGestureListener() {
            override fun onDoubleTap(e: MotionEvent): Boolean {
                startListening()
                return true
            }
        })

        val missing = permissions.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isNotEmpty()) ActivityCompat.requestPermissions(this, missing.toTypedArray(), 1)

        handleLaunch(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleLaunch(intent)
    }

    /**
     * Ways to start listening straight away: the "Bolo" icon, the long-press shortcut,
     * the Quick Settings button, the phone's assistant gesture, or a quick second tap after opening.
     */
    private fun handleLaunch(i: Intent?) {
        val fromBoloIcon = i?.component?.className?.endsWith(".ListenNow") == true
        if (i?.action == ACTION_LISTEN || i?.action == Intent.ACTION_ASSIST || fromBoloIcon) {
            returnAfter = i?.getBooleanExtra(EXTRA_FROM_BUTTON, false) == true
            startListening()
        } else if (i?.action == Intent.ACTION_MAIN) {
            secondTapUntil = SystemClock.uptimeMillis() + SECOND_TAP_WINDOW_MS
        }
    }

    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        if (ev.actionMasked == MotionEvent.ACTION_DOWN && SystemClock.uptimeMillis() < secondTapUntil) {
            secondTapUntil = 0L
            startListening()
            return true
        }
        gestures.onTouchEvent(ev)
        return super.dispatchTouchEvent(ev)
    }

    override fun onResume() {
        super.onResume()
        autoTapHint.visibility = if (AutoTapService.isRunning() || isAutoTapOn()) View.GONE else View.VISIBLE
    }

    override fun onInit(result: Int) {
        if (result == TextToSpeech.SUCCESS) tts?.language = Locale("en", "IN")
    }

    private fun startListening() {
        if (listening) return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED
        ) {
            ActivityCompat.requestPermissions(this, permissions, 1); return
        }
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            status.text = "Speech recognition nahi mila. Google app install/update kijiye."
            return
        }
        listening = true
        recognizer?.destroy()
        recognizer = SpeechRecognizer.createSpeechRecognizer(this).apply {
            setRecognitionListener(listener)
            startListening(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                // en-IN gives Hinglish in Roman letters ("papa ko call karo"), which the parser understands
                putExtra(RecognizerIntent.EXTRA_LANGUAGE, "en-IN")
                putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
            })
        }
        status.text = "Sun raha hoon…"
    }

    private val listener = object : RecognitionListener {
        override fun onReadyForSpeech(p: Bundle?) { status.text = "Boliye…" }
        override fun onPartialResults(b: Bundle?) {
            b?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.let { heard.text = it }
        }
        override fun onResults(b: Bundle?) {
            listening = false
            val options = b?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION).orEmpty()
            if (options.isEmpty()) { status.text = "Kuch sunai nahi diya"; return }
            // Use the first alternative the parser understands
            val (text, cmd) = options.map { it to CommandParser.parse(it) }
                .firstOrNull { it.second !is Command.Unknown } ?: (options[0] to Command.Unknown(options[0]))
            heard.text = "“$text”"
            val reply = executor.execute(cmd)
            status.text = reply
            tts?.speak(reply, TextToSpeech.QUEUE_FLUSH, null, "reply")
            // Opened from the floating button over another app: quick jobs return you to that app
            if (returnAfter && (cmd is Command.Torch || cmd is Command.Volume)) moveTaskToBack(true)
            returnAfter = false
        }
        override fun onError(error: Int) {
            listening = false
            status.text = when (error) {
                SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "Samajh nahi aaya, double-tap karke phir boliye"
                SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Internet check kijiye"
                SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Mic ki permission dijiye"
                else -> "Error ($error), phir se try kijiye"
            }
        }
        override fun onBeginningOfSpeech() {}
        override fun onRmsChanged(v: Float) {}
        override fun onBufferReceived(b: ByteArray?) {}
        override fun onEndOfSpeech() { status.text = "Samajh raha hoon…" }
        override fun onEvent(t: Int, b: Bundle?) {}
    }

    private fun isAutoTapOn(): Boolean {
        val enabled = Settings.Secure.getString(contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
        return enabled.contains("$packageName/") && enabled.contains("AutoTapService")
    }

    override fun onDestroy() {
        recognizer?.destroy()
        tts?.shutdown()
        super.onDestroy()
    }
}
