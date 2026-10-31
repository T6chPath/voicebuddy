package com.voicebuddy.app

import android.Manifest
import android.animation.Animator
import android.animation.ObjectAnimator
import android.animation.PropertyValuesHolder
import android.animation.ValueAnimator
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.Color
import android.os.Bundle
import android.os.SystemClock
import android.provider.Settings
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.util.TypedValue
import android.view.GestureDetector
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.animation.AccelerateDecelerateInterpolator
import android.view.animation.DecelerateInterpolator
import android.widget.GridLayout
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import java.util.Calendar
import java.util.Locale

class MainActivity : AppCompatActivity(), TextToSpeech.OnInitListener {

    companion object {
        const val ACTION_LISTEN = "com.voicebuddy.app.LISTEN"
        /** Started from the floating button while another app was open: go back to it afterwards. */
        const val EXTRA_FROM_BUTTON = "from_button"
        /** A tap within this time after opening the app counts as the "second tap" of a double tap. */
        private const val SECOND_TAP_WINDOW_MS = 1500L
        private const val MAX_RECENT = 5
    }

    private lateinit var status: TextView
    private lateinit var heard: TextView
    private lateinit var replyRow: View
    private lateinit var replyText: TextView
    private lateinit var autoTapHint: View
    private lateinit var autoTapIcon: ImageView
    private lateinit var autoTapTitle: TextView
    private lateinit var autoTapText: TextView
    private lateinit var langText: TextView
    private lateinit var mic: ImageButton
    private lateinit var glow: View
    private lateinit var rings: List<View>
    private lateinit var recentTitle: TextView
    private lateinit var recentList: LinearLayout
    private lateinit var prefs: SharedPreferences

    private var recognizer: SpeechRecognizer? = null
    private var tts: TextToSpeech? = null
    private lateinit var executor: ActionExecutor
    private lateinit var gestures: GestureDetector
    private var listening = false
    private var secondTapUntil = 0L
    private var returnAfter = false
    private var torchOn = false
    /** "en-IN" = Hinglish / English in Roman letters, "hi-IN" = Hindi (हिंदी). Both are understood. */
    private var speechLang = "en-IN"

    private val ringAnimators = mutableListOf<Animator>()
    private var idleAnimator: Animator? = null

    private val accent = Color.parseColor("#FF8A3D")
    private val mint = Color.parseColor("#3DDC97")
    private val marigold = Color.parseColor("#FFB547")

    private val permissions = arrayOf(
        Manifest.permission.RECORD_AUDIO,
        Manifest.permission.READ_CONTACTS,
        Manifest.permission.CALL_PHONE,
        Manifest.permission.READ_PHONE_STATE
    )

    private data class Quick(val label: String, val icon: Int, val color: String, val command: () -> String)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        prefs = getSharedPreferences("voicebuddy", MODE_PRIVATE)

        status = findViewById(R.id.statusText)
        heard = findViewById(R.id.heardText)
        replyRow = findViewById(R.id.replyRow)
        replyText = findViewById(R.id.replyText)
        autoTapHint = findViewById(R.id.autoTapHint)
        autoTapIcon = findViewById(R.id.autoTapIcon)
        autoTapTitle = findViewById(R.id.autoTapTitle)
        autoTapText = findViewById(R.id.autoTapText)
        langText = findViewById(R.id.langText)
        mic = findViewById(R.id.micButton)
        glow = findViewById(R.id.glow)
        rings = listOf(findViewById(R.id.ring1), findViewById(R.id.ring2), findViewById(R.id.ring3))
        recentTitle = findViewById(R.id.recentTitle)
        recentList = findViewById(R.id.recentList)

        executor = ActionExecutor(this)
        tts = TextToSpeech(this, this)

        speechLang = prefs.getString("lang", "en-IN") ?: "en-IN"
        showLang()
        findViewById<View>(R.id.langToggle).setOnClickListener {
            speechLang = if (speechLang == "en-IN") "hi-IN" else "en-IN"
            prefs.edit().putString("lang", speechLang).apply()
            showLang()
        }

        mic.setOnClickListener { if (listening) stopListening() else startListening() }
        autoTapHint.setOnClickListener { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }

        gestures = GestureDetector(this, object : GestureDetector.SimpleOnGestureListener() {
            override fun onDoubleTap(e: MotionEvent): Boolean {
                startListening()
                return true
            }
        })

        findViewById<TextView>(R.id.greetingText).text = greeting()
        buildQuickActions()
        buildSuggestions()
        renderRecent()
        startIdle()

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
        updateAutoTapCard()
        findViewById<TextView>(R.id.greetingText).text = greeting()
    }

    override fun onInit(result: Int) {
        if (result == TextToSpeech.SUCCESS) tts?.language = Locale("en", "IN")
    }

    // ---------- Home page pieces ----------
    private fun greeting(): String {
        val h = Calendar.getInstance().get(Calendar.HOUR_OF_DAY)
        val part = when (h) {
            in 5..11 -> "Good morning"
            in 12..16 -> "Good afternoon"
            in 17..21 -> "Good evening"
            else -> "Shubh ratri"
        }
        return "Namaste · $part"
    }

    private fun showLang() {
        langText.text = if (speechLang == "hi-IN") "हिंदी" else "Hinglish"
    }

    private fun updateAutoTapCard() {
        val on = AutoTapService.isRunning() || isAutoTapOn()
        val color = if (on) mint else marigold
        autoTapIcon.backgroundTintList = ColorStateList.valueOf(withAlpha(color, 0.18f))
        autoTapIcon.imageTintList = ColorStateList.valueOf(color)
        autoTapTitle.text = if (on) "Auto-Tap ON" else "Auto-Tap OFF"
        autoTapTitle.setTextColor(color)
        autoTapText.text = if (on) "Send, play aur switch sab apne aap ho jayega"
        else "Yahan tap karke on karo: auto-send, auto-play, Wi-Fi switch"
    }

    private fun buildQuickActions() {
        val grid = findViewById<GridLayout>(R.id.quickGrid)
        val actions = listOf(
            Quick("Torch", R.drawable.ic_flashlight, "#FFB547") {
                torchOn = !torchOn
                if (torchOn) "torch on karo" else "torch band karo"
            },
            Quick("Volume +", R.drawable.ic_volume, "#FF8A3D") { "volume badhao" },
            Quick("Screenshot", R.drawable.ic_screenshot, "#3DDC97") { "screenshot lo" },
            Quick("YouTube", R.drawable.ic_play, "#FF4E45") { "youtube kholo" },
            Quick("WhatsApp", R.drawable.ic_chat, "#25D366") { "whatsapp kholo" },
            Quick("ChatGPT", R.drawable.ic_sparkle, "#19C37D") { "chatgpt kholo" },
            Quick("Gmail", R.drawable.ic_mail, "#EA4335") { "gmail kholo" },
            Quick("Maps", R.drawable.ic_place, "#4A9CFF") { "maps kholo" }
        )
        for (q in actions) {
            val color = Color.parseColor(q.color)
            val tile = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER_HORIZONTAL
                setPadding(0, dp(6), 0, dp(10))
                foreground = themeDrawable(android.R.attr.selectableItemBackgroundBorderless)
                isClickable = true
                contentDescription = q.label
                setOnClickListener { runText(q.command(), fromVoice = false) }
            }
            val icon = ImageView(this).apply {
                setImageResource(q.icon)
                setBackgroundResource(R.drawable.tile_icon_bg)
                backgroundTintList = ColorStateList.valueOf(withAlpha(color, 0.16f))
                imageTintList = ColorStateList.valueOf(color)
                setPadding(dp(14), dp(14), dp(14), dp(14))
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            }
            tile.addView(icon, LinearLayout.LayoutParams(dp(54), dp(54)))
            tile.addView(TextView(this).apply {
                text = q.label
                setTextColor(ContextCompat.getColor(context, R.color.text))
                textSize = 12f
                gravity = Gravity.CENTER
                maxLines = 1
                setPadding(0, dp(8), 0, 0)
            })
            val lp = GridLayout.LayoutParams(
                GridLayout.spec(GridLayout.UNDEFINED),
                GridLayout.spec(GridLayout.UNDEFINED, 1f)
            ).apply { width = 0 }
            grid.addView(tile, lp)
        }
    }

    private fun buildSuggestions() {
        val row = findViewById<LinearLayout>(R.id.suggestionRow)
        val ideas = listOf(
            "Papa ko WhatsApp video call karo" to "WhatsApp",
            "YouTube pe Kesariya chalao" to "YouTube",
            "Suraj ko message bhejo ki kal milte hain" to "Message",
            "Call Suraj Singh by SIM 1" to "Call",
            "ChatGPT se pucho aaj ka mausam kaisa hai" to "ChatGPT",
            "Wi-Fi band karo" to "Settings",
            "Instagram pe search karo Virat Kohli" to "Instagram",
            "Pradhuman ko email bhejo ki kal meeting hai" to "Gmail"
        )
        for ((i, pair) in ideas.withIndex()) {
            val (phrase, tag) = pair
            val card = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setBackgroundResource(R.drawable.suggestion_card)
                setPadding(dp(14), dp(12), dp(14), dp(14))
                foreground = themeDrawable(android.R.attr.selectableItemBackground)
                isClickable = true
                // Shows the phrase and starts listening, so nothing is sent or dialled by accident
                setOnClickListener {
                    heard.text = "Boliye: “$phrase”"
                    startListening()
                }
            }
            card.addView(TextView(this).apply {
                text = tag.uppercase(Locale.ROOT)
                letterSpacing = 0.08f
                textSize = 10f
                setTextColor(if (i % 2 == 0) accent else mint)
            })
            card.addView(TextView(this).apply {
                text = "“$phrase”"
                textSize = 14f
                setTextColor(ContextCompat.getColor(context, R.color.text))
                setPadding(0, dp(6), 0, 0)
                maxLines = 3
            })
            val lp = LinearLayout.LayoutParams(dp(176), LinearLayout.LayoutParams.WRAP_CONTENT)
            lp.marginEnd = dp(10)
            row.addView(card, lp)
        }
    }

    private fun recentItems(): List<String> =
        prefs.getString("recent", "").orEmpty().split("\n").filter { it.isNotBlank() }

    private fun rememberCommand(text: String) {
        val items = (listOf(text) + recentItems().filter { !it.equals(text, true) }).take(MAX_RECENT)
        prefs.edit().putString("recent", items.joinToString("\n")).apply()
        renderRecent()
    }

    private fun renderRecent() {
        val items = recentItems()
        recentList.removeAllViews()
        recentTitle.visibility = if (items.isEmpty()) View.GONE else View.VISIBLE
        for (t in items) {
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setBackgroundResource(R.drawable.card_surface)
                setPadding(dp(14), dp(12), dp(12), dp(12))
                foreground = themeDrawable(android.R.attr.selectableItemBackground)
                isClickable = true
                contentDescription = "Dobara: $t"
                setOnClickListener { runText(t, fromVoice = false) }
            }
            row.addView(ImageView(this).apply {
                setImageResource(R.drawable.ic_history)
                imageTintList = ColorStateList.valueOf(ContextCompat.getColor(context, R.color.muted))
            }, LinearLayout.LayoutParams(dp(18), dp(18)))
            row.addView(TextView(this).apply {
                text = t
                textSize = 14f
                maxLines = 1
                ellipsize = android.text.TextUtils.TruncateAt.END
                setTextColor(ContextCompat.getColor(context, R.color.text))
                setPadding(dp(12), 0, dp(8), 0)
            }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            row.addView(TextView(this).apply {
                text = "Dobara"
                textSize = 12f
                setTextColor(accent)
            })
            val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            lp.bottomMargin = dp(8)
            recentList.addView(row, lp)
        }
    }

    // ---------- Running a command ----------
    private fun runText(text: String, fromVoice: Boolean) {
        val cmd = CommandParser.parse(text)
        heard.text = "“$text”"
        val reply = executor.execute(cmd)
        showReply(reply)
        tts?.speak(reply, TextToSpeech.QUEUE_FLUSH, null, "reply")
        if (fromVoice) rememberCommand(text)
        // Opened from the floating button over another app: quick jobs return you to that app
        if (returnAfter && (cmd is Command.Torch || cmd is Command.Volume)) moveTaskToBack(true)
        returnAfter = false
    }

    private fun showReply(reply: String) {
        replyText.text = reply
        if (replyRow.visibility != View.VISIBLE) {
            replyRow.alpha = 0f
            replyRow.translationY = dp(8).toFloat()
            replyRow.visibility = View.VISIBLE
        }
        replyRow.animate().alpha(1f).translationY(0f).setDuration(220).setInterpolator(DecelerateInterpolator()).start()
    }

    // ---------- Listening ----------
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
                putExtra(RecognizerIntent.EXTRA_LANGUAGE, speechLang)
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, speechLang)
                putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 5)
            })
        }
        status.text = "Sun raha hoon…"
        status.setTextColor(accent)
        startRings()
    }

    private fun stopListening() {
        recognizer?.stopListening()
    }

    private fun endListening() {
        listening = false
        stopRings()
        status.setTextColor(ContextCompat.getColor(this, R.color.muted))
    }

    private val listener = object : RecognitionListener {
        override fun onReadyForSpeech(p: Bundle?) { status.text = "Boliye…" }
        override fun onPartialResults(b: Bundle?) {
            b?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.let { heard.text = it }
        }
        override fun onResults(b: Bundle?) {
            endListening()
            val options = b?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION).orEmpty()
            if (options.isEmpty()) { status.text = "Kuch sunai nahi diya"; return }
            // Use the first alternative the parser understands
            val text = options.firstOrNull { CommandParser.parse(it) !is Command.Unknown } ?: options[0]
            status.text = "Mic dabao ya kahin bhi double-tap karo"
            runText(text, fromVoice = true)
        }
        override fun onError(error: Int) {
            endListening()
            status.text = when (error) {
                SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "Samajh nahi aaya, mic dabake phir boliye"
                SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Internet check kijiye"
                SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Mic ki permission dijiye"
                else -> "Phir se try kijiye (error $error)"
            }
        }
        override fun onBeginningOfSpeech() {}
        override fun onRmsChanged(v: Float) {
            // the orb swells with your voice
            val s = 1f + (v.coerceIn(0f, 10f) / 10f) * 0.12f
            mic.scaleX = s
            mic.scaleY = s
        }
        override fun onBufferReceived(b: ByteArray?) {}
        override fun onEndOfSpeech() { status.text = "Samajh raha hoon…" }
        override fun onEvent(t: Int, b: Bundle?) {}
    }

    // ---------- Animation ----------
    private fun startIdle() {
        idleAnimator = ObjectAnimator.ofPropertyValuesHolder(
            glow,
            PropertyValuesHolder.ofFloat(View.SCALE_X, 0.92f, 1.04f),
            PropertyValuesHolder.ofFloat(View.SCALE_Y, 0.92f, 1.04f),
            PropertyValuesHolder.ofFloat(View.ALPHA, 0.7f, 1f)
        ).apply {
            duration = 2400
            repeatCount = ValueAnimator.INFINITE
            repeatMode = ValueAnimator.REVERSE
            interpolator = AccelerateDecelerateInterpolator()
            start()
        }
    }

    private fun startRings() {
        stopRings()
        rings.forEachIndexed { i, ring ->
            val a = ObjectAnimator.ofPropertyValuesHolder(
                ring,
                PropertyValuesHolder.ofFloat(View.SCALE_X, 1f, 1.75f),
                PropertyValuesHolder.ofFloat(View.SCALE_Y, 1f, 1.75f),
                PropertyValuesHolder.ofFloat(View.ALPHA, 0.75f, 0f)
            ).apply {
                duration = 1800
                startDelay = i * 600L
                repeatCount = ValueAnimator.INFINITE
                interpolator = DecelerateInterpolator()
                start()
            }
            ringAnimators.add(a)
        }
    }

    private fun stopRings() {
        ringAnimators.forEach { it.cancel() }
        ringAnimators.clear()
        rings.forEach { it.alpha = 0f; it.scaleX = 1f; it.scaleY = 1f }
        mic.animate().scaleX(1f).scaleY(1f).setDuration(150).start()
    }

    // ---------- helpers ----------
    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    private fun withAlpha(color: Int, a: Float): Int =
        Color.argb((a * 255).toInt(), Color.red(color), Color.green(color), Color.blue(color))

    private fun themeDrawable(attr: Int) = TypedValue().let { tv ->
        theme.resolveAttribute(attr, tv, true)
        ContextCompat.getDrawable(this, tv.resourceId)
    }

    private fun isAutoTapOn(): Boolean {
        val enabled = Settings.Secure.getString(contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
        return enabled.contains("$packageName/") && enabled.contains("AutoTapService")
    }

    override fun onDestroy() {
        idleAnimator?.cancel()
        ringAnimators.forEach { it.cancel() }
        recognizer?.destroy()
        tts?.shutdown()
        super.onDestroy()
    }
}
