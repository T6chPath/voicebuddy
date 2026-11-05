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
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.GravityCompat
import androidx.drawerlayout.widget.DrawerLayout
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import java.util.Calendar
import java.util.Locale

class MainActivity : AppCompatActivity(), TextToSpeech.OnInitListener {

    companion object {
        const val ACTION_LISTEN = "com.voicebuddy.app.LISTEN"
        /** Started from the floating button while another app was open: go back to it afterwards. */
        const val EXTRA_FROM_BUTTON = "from_button"
        const val EXTRA_AUTOTAP_DONE = "autotap_done"
        /** A tap within this time after opening the app counts as the "second tap" of a double tap. */
        private const val SECOND_TAP_WINDOW_MS = 1500L
        private const val MAX_RECENT = 20
    }

    private lateinit var status: TextView
    private lateinit var heard: TextView
    private lateinit var replyRow: View
    private lateinit var replyText: TextView
    private lateinit var drawer: DrawerLayout
    private lateinit var settingsBadge: View
    private lateinit var recentEmpty: TextView
    private lateinit var mic: ImageButton
    private lateinit var glow: View
    private lateinit var rings: List<View>
    private lateinit var recentList: LinearLayout
    private lateinit var prefs: SharedPreferences

    private var recognizer: SpeechRecognizer? = null
    private var tts: TextToSpeech? = null
    private lateinit var executor: ActionExecutor
    private lateinit var gestures: GestureDetector
    private var listening = false
    private var secondTapUntil = 0L
    private var returnAfter = false
    /** "en-IN" = Hinglish / English in Roman letters, "hi-IN" = Hindi (हिंदी). Both are understood. */
    private var speechLang = "en-IN"

    private val ringAnimators = mutableListOf<Animator>()
    private var idleAnimator: Animator? = null

    private val accent = Color.parseColor("#FFC233")
    private val mint = Color.parseColor("#3DDC97")
    private val marigold = Color.parseColor("#FFD24D")

    private val permissions = arrayOf(
        Manifest.permission.RECORD_AUDIO,
        Manifest.permission.READ_CONTACTS,
        Manifest.permission.CALL_PHONE,
        Manifest.permission.READ_PHONE_STATE
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        prefs = getSharedPreferences("voicebuddy", MODE_PRIVATE)

        status = findViewById(R.id.statusText)
        heard = findViewById(R.id.heardText)
        replyRow = findViewById(R.id.replyRow)
        replyText = findViewById(R.id.replyText)
        drawer = findViewById(R.id.drawer)
        settingsBadge = findViewById(R.id.settingsBadge)
        mic = findViewById(R.id.micButton)
        glow = findViewById(R.id.glow)
        rings = listOf(findViewById(R.id.ring1), findViewById(R.id.ring2), findViewById(R.id.ring3))
        recentList = findViewById(R.id.recentList)
        recentEmpty = findViewById(R.id.recentEmpty)

        executor = ActionExecutor(this)
        tts = TextToSpeech(this, this)
        speechLang = SpeechLanguage.get(this)

        mic.setOnClickListener { if (listening) stopListening() else startListening() }
        findViewById<View>(R.id.menuButton).setOnClickListener { drawer.openDrawer(GravityCompat.START) }
        findViewById<View>(R.id.settingsButton).setOnClickListener { openSettings() }
        findViewById<View>(R.id.drawerSettings).setOnClickListener {
            drawer.closeDrawer(GravityCompat.START)
            openSettings()
        }
        findViewById<View>(R.id.clearRecent).setOnClickListener {
            prefs.edit().remove("recent").apply()
            renderRecent()
        }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (drawer.isDrawerOpen(GravityCompat.START)) {
                    drawer.closeDrawer(GravityCompat.START)
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                    isEnabled = true
                }
            }
        })

        gestures = GestureDetector(this, object : GestureDetector.SimpleOnGestureListener() {
            override fun onDoubleTap(e: MotionEvent): Boolean {
                if (!drawer.isDrawerOpen(GravityCompat.START)) startListening()
                return true
            }
        })

        autoToggle = findViewById(R.id.autoToggle)
        autoToggle.onToggle = { on ->
            if (on) {
                if (AutoTapHelper.switchOn(this)) toast("⚡ Apne aap mode ON — sab kaam khud honge")
            } else {
                AutoTapHelper.switchOff(this)
                toast("Apne aap mode OFF — Send jaise button aap khud dabayenge")
            }
        }
        styleTitle()
        findViewById<TextView>(R.id.greetingText).text = greeting()
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
        if (i?.getBooleanExtra(EXTRA_AUTOTAP_DONE, false) == true) {
            i.removeExtra(EXTRA_AUTOTAP_DONE)
            // Permission just given: finish the command that was waiting for it
            val pending = AutoTapHelper.takePending(this)
            if (pending != null) {
                mic.postDelayed({ runText(pending, fromVoice = false) }, 700)
            } else {
                val msg = "Ho gaya! Ab sab kaam apne aap honge."
                showReply(msg)
                tts?.speak(msg, TextToSpeech.QUEUE_FLUSH, null, "ready")
            }
            return
        }
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
        speechLang = SpeechLanguage.get(this)
        AutoTapHelper.tryEnableSilently(this)   // only works if WRITE_SECURE_SETTINGS was granted once
        AutoTapKeeper.ensure(this)
        settingsBadge.visibility = View.GONE
        autoToggle.setOn(AutoTapHelper.isActive(this), animate = false)
        AutoTapHelper.checkReturned(this)
        findViewById<TextView>(R.id.greetingText).text = greeting()
    }

    override fun onInit(result: Int) {
        if (result == TextToSpeech.SUCCESS) tts?.language = Locale("en", "IN")
        // After asking "kya message bhejna hai?", start listening for the answer by itself
        tts?.setOnUtteranceProgressListener(object : android.speech.tts.UtteranceProgressListener() {
            override fun onStart(id: String?) = Unit
            override fun onDone(id: String?) { if (id == "ask") runOnUiThread { if (!listening) startListening() } }
            @Deprecated("Deprecated in Java")
            override fun onError(id: String?) = Unit
        })
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
        // sun by day, moon by night
        findViewById<ImageView>(R.id.greetingIcon).setImageResource(
            if (h in 6..17) R.drawable.ic_sun else R.drawable.ic_moon
        )
        return "Namaste · $part"
    }

    /** "zenvqo" in white, ".voice" in crown gold. */
    private fun styleTitle() {
        val name = "zenvqo.voice"
        val dot = name.indexOf('.')
        val span = android.text.SpannableString(name)
        span.setSpan(
            android.text.style.ForegroundColorSpan(accent), dot, name.length,
            android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE
        )
        findViewById<TextView>(R.id.titleText).text = span
    }

    private fun openSettings() = startActivity(Intent(this, SettingsActivity::class.java))

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
        recentEmpty.visibility = if (items.isEmpty()) View.VISIBLE else View.GONE
        for (t in items) {
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setBackgroundResource(R.drawable.card_surface)
                setPadding(dp(14), dp(12), dp(12), dp(12))
                foreground = themeDrawable(android.R.attr.selectableItemBackground)
                isClickable = true
                contentDescription = "Dobara: $t"
                setOnClickListener {
                    drawer.closeDrawer(GravityCompat.START)
                    runText(t, fromVoice = false)
                }
            }
            row.addView(TextView(this).apply {
                text = t
                textSize = 14f
                maxLines = 2
                ellipsize = android.text.TextUtils.TruncateAt.END
                setTextColor(ContextCompat.getColor(context, R.color.text))
            }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            row.addView(ImageView(this).apply {
                setImageResource(R.drawable.ic_history)
                imageTintList = ColorStateList.valueOf(accent)
                contentDescription = "Dobara chalao"
            }, LinearLayout.LayoutParams(dp(18), dp(18)).apply { marginStart = dp(10) })
            val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            lp.bottomMargin = dp(8)
            recentList.addView(row, lp)
        }
    }

    // ---------- Running a command ----------
    private lateinit var autoToggle: AutoToggleView

    private fun toast(t: String) = android.widget.Toast.makeText(this, t, android.widget.Toast.LENGTH_SHORT).show()

    /** Who the next spoken words go to, after "kya message bhejna hai X ko?". */
    private var followUpName: String? = null

    private fun runText(text: String, fromVoice: Boolean) {
        val askedFor = followUpName
        followUpName = null
        if (askedFor != null && Regex("^\\s*(cancel|rehne do|rahne do|chhodo|chodo|mat bhejo|nahi|no|stop)\\b", RegexOption.IGNORE_CASE).containsMatchIn(text)) {
            showReply("Theek hai, nahi bheja.")
            tts?.speak("Theek hai", TextToSpeech.QUEUE_FLUSH, null, "reply")
            return
        }
        val cmd = if (askedFor != null) Command.WhatsAppMessage(askedFor, text.trim()) else CommandParser.parse(text)
        heard.text = "“$text”"
        // Jobs that finish themselves (send, play, switch…) need Android's one-time permission.
        // If it's missing, ask once; the command then runs by itself as soon as it's given.
        if (needsHelper(cmd) && AutoTapHelper.wanted(this) && !AutoTapHelper.ensureReady(this, text)) {
            autoToggle.setOn(true)
            val wait = "zenvqo.voice ON kijiye — phir ye kaam apne aap ho jayega."
            showReply(wait)
            tts?.speak(wait, TextToSpeech.QUEUE_FLUSH, null, "reply")
            if (fromVoice) rememberCommand(text)
            return
        }
        val reply = executor.execute(cmd)
        showReply(reply)
        // "papa ko message karo" with no message: ask, then listen and send the answer
        val ask = Regex("^Kya message bhejna hai (.+) ko\\?$").find(reply)
        if (ask != null) followUpName = ask.groupValues[1]
        tts?.speak(reply, TextToSpeech.QUEUE_FLUSH, null, if (ask != null) "ask" else "reply")
        if (fromVoice) rememberCommand(text)
        // Opened from the floating button over another app: quick jobs return you to that app
        if (returnAfter && (cmd is Command.Torch || cmd is Command.Volume)) moveTaskToBack(true)
        returnAfter = false
    }

    /** Commands that are finished on screen by the background helper (not just opened). */
    private fun needsHelper(cmd: Command): Boolean = when (cmd) {
        is Command.WhatsAppMessage, is Command.WhatsApp, is Command.Toggle, is Command.Global,
        is Command.TapOn, is Command.TypeText, is Command.Scroll, is Command.AppSearch, is Command.DoInApp -> true
        is Command.SearchIn -> cmd.app in setOf(SearchApp.CHATGPT, SearchApp.CLAUDE, SearchApp.GEMINI)
        is Command.Email -> cmd.body.isNotBlank()
        is Command.System -> cmd.action in setOf(SysAct.BATTERY_SAVER, SysAct.READING_MODE, SysAct.SCREEN_RECORD)
        else -> false
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
            status.text = "Chidiya pe tap karo ya kahin bhi double-tap karo"
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
        // The bird floats gently, like it's hovering on its mic
        if (birdFloat == null) birdFloat = ObjectAnimator.ofFloat(mic, View.TRANSLATION_Y, 0f, -dp(7).toFloat()).apply {
            duration = 1800
            repeatCount = ValueAnimator.INFINITE
            repeatMode = ValueAnimator.REVERSE
            interpolator = AccelerateDecelerateInterpolator()
            start()
        }
    }

    private var birdFloat: ObjectAnimator? = null

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

    override fun onDestroy() {
        idleAnimator?.cancel()
        ringAnimators.forEach { it.cancel() }
        recognizer?.destroy()
        tts?.shutdown()
        super.onDestroy()
    }
}
