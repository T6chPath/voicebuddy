package com.voicebuddy.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.provider.Settings
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.view.View
import android.widget.ImageButton
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import java.util.Locale

class MainActivity : AppCompatActivity(), TextToSpeech.OnInitListener {

    private lateinit var status: TextView
    private lateinit var heard: TextView
    private lateinit var autoTapHint: TextView
    private var recognizer: SpeechRecognizer? = null
    private var tts: TextToSpeech? = null
    private lateinit var executor: ActionExecutor

    private val permissions = arrayOf(
        Manifest.permission.RECORD_AUDIO,
        Manifest.permission.READ_CONTACTS,
        Manifest.permission.CALL_PHONE
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
        autoTapHint.setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }

        val missing = permissions.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isNotEmpty()) ActivityCompat.requestPermissions(this, missing.toTypedArray(), 1)

        // Opened as the phone's assistant (long-press home)? Start listening right away.
        if (intent?.action == Intent.ACTION_ASSIST) startListening()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.action == Intent.ACTION_ASSIST) startListening()
    }

    override fun onResume() {
        super.onResume()
        autoTapHint.visibility = if (isAutoTapOn()) View.GONE else View.VISIBLE
    }

    override fun onInit(result: Int) {
        if (result == TextToSpeech.SUCCESS) tts?.language = Locale("en", "IN")
    }

    private fun startListening() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED
        ) {
            ActivityCompat.requestPermissions(this, permissions, 1); return
        }
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            status.text = "Speech recognition is not available. Install/update the Google app."
            return
        }
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
            val options = b?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION).orEmpty()
            if (options.isEmpty()) { status.text = "Kuch sunai nahi diya"; return }
            // Use the first alternative the parser understands
            val (text, cmd) = options.map { it to CommandParser.parse(it) }
                .firstOrNull { it.second !is Command.Unknown } ?: (options[0] to Command.Unknown(options[0]))
            heard.text = "“$text”"
            val reply = executor.execute(cmd)
            status.text = reply
            tts?.speak(reply, TextToSpeech.QUEUE_FLUSH, null, "reply")
        }
        override fun onError(error: Int) {
            status.text = when (error) {
                SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "Samajh nahi aaya, phir se mic dabaiye"
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
