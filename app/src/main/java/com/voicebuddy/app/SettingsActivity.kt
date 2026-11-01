package com.voicebuddy.app

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat

/** Speech language choices. All three understand every command; this only changes how speech is written down. */
object SpeechLanguage {
    const val PREFS = "voicebuddy"
    private const val KEY = "lang"
    const val HINGLISH = "en-IN"
    const val HINDI = "hi-IN"
    const val ENGLISH = "en-US"

    fun get(c: Context): String =
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, HINGLISH) ?: HINGLISH

    fun set(c: Context, code: String) =
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, code).apply()

    fun label(code: String) = when (code) {
        HINDI -> "हिंदी"
        ENGLISH -> "English"
        else -> "Hinglish"
    }
}

class SettingsActivity : AppCompatActivity() {

    private val accent = Color.parseColor("#FF8A3D")
    private val mint = Color.parseColor("#3DDC97")
    private val marigold = Color.parseColor("#FFB547")

    private lateinit var langOptions: LinearLayout

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)
        findViewById<View>(R.id.backButton).setOnClickListener { finish() }
        langOptions = findViewById(R.id.langOptions)
        findViewById<View>(R.id.autoTapButton).setOnClickListener {
            if (isAutoTapOn(this)) AutoTapHelper.openSwitch(this) else AutoTapHelper.turnOn(this)
        }
        renderLanguages()
        buildMore()
        val version = try { packageManager.getPackageInfo(packageName, 0).versionName } catch (e: Exception) { "" }
        findViewById<TextView>(R.id.versionText).text = "zenvqo.voice $version"
    }

    override fun onResume() {
        super.onResume()
        renderAutoTap()
    }

    // ---------- Language ----------
    private fun renderLanguages() {
        langOptions.removeAllViews()
        val current = SpeechLanguage.get(this)
        val options = listOf(
            Triple(SpeechLanguage.HINGLISH, "Hinglish", "Hindi + English mix · “Papa ko call karo”"),
            Triple(SpeechLanguage.HINDI, "हिंदी · Hindi", "Poori Hindi mein bolo · “पापा को कॉल करो”"),
            Triple(SpeechLanguage.ENGLISH, "English", "Only English · “Call Papa”")
        )
        for ((code, title, sub) in options) {
            val selected = code == current
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setBackgroundResource(if (selected) R.drawable.option_selected else R.drawable.card_surface)
                setPadding(dp(16), dp(14), dp(14), dp(14))
                foreground = themeDrawable(android.R.attr.selectableItemBackground)
                isClickable = true
                contentDescription = title
                setOnClickListener {
                    SpeechLanguage.set(this@SettingsActivity, code)
                    renderLanguages()
                }
            }
            val texts = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
            texts.addView(TextView(this).apply {
                text = title
                textSize = 16f
                setTextColor(ContextCompat.getColor(context, R.color.text))
                typeface = android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL)
            })
            texts.addView(TextView(this).apply {
                text = sub
                textSize = 13f
                setTextColor(ContextCompat.getColor(context, R.color.muted))
                setPadding(0, dp(2), 0, 0)
            })
            row.addView(texts, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            row.addView(ImageView(this).apply {
                setImageResource(R.drawable.ic_check)
                imageTintList = ColorStateList.valueOf(accent)
                visibility = if (selected) View.VISIBLE else View.INVISIBLE
            }, LinearLayout.LayoutParams(dp(22), dp(22)))
            val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            lp.bottomMargin = dp(10)
            langOptions.addView(row, lp)
        }
    }

    // ---------- Auto-Tap ----------
    private fun renderAutoTap() {
        val on = isAutoTapOn(this)
        val color = if (on) mint else marigold
        findViewById<ImageView>(R.id.autoTapIcon).apply {
            backgroundTintList = ColorStateList.valueOf(withAlpha(color, 0.18f))
            imageTintList = ColorStateList.valueOf(color)
        }
        findViewById<TextView>(R.id.autoTapTitle).apply {
            text = if (on) "Auto-Tap ON" else "Auto-Tap OFF"
            setTextColor(color)
        }
        findViewById<TextView>(R.id.autoTapText).text =
            if (on) "Sab kaam apne aap ho raha hai" else "Abhi kuch kaam aapko khud tap karne padenge"
        findViewById<TextView>(R.id.autoTapButton).text =
            if (on) "Auto-Tap settings kholo" else "Auto-Tap on karo"
    }

    // ---------- More ----------
    private fun buildMore() {
        val box = findViewById<LinearLayout>(R.id.moreOptions)
        addRow(box, R.drawable.ic_assistant, "Default assistant banao",
            "Home / Power button daba ke rakhne par zenvqo.voice khule") {
            open(Intent(Settings.ACTION_VOICE_INPUT_SETTINGS), Intent(Settings.ACTION_SETTINGS))
        }
        addRow(box, R.drawable.ic_shield, "Permissions",
            "Mic, Contacts, Phone — SIM chunne ke liye Phone zaroori") {
            open(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
        }

        val support = findViewById<LinearLayout>(R.id.supportOptions)
        addRow(support, R.drawable.ic_policy, "Privacy Policy", "Aapka data kaise use hota hai") {
            InfoActivity.open(this, InfoActivity.PRIVACY)
        }
        addRow(support, R.drawable.ic_doc, "Terms & Conditions", "App use karne ki shartein") {
            InfoActivity.open(this, InfoActivity.TERMS)
        }
        addRow(support, R.drawable.ic_mail, "Contact Us", InfoActivity.CONTACT_EMAIL) {
            InfoActivity.open(this, InfoActivity.CONTACT)
        }
        addRow(support, R.drawable.ic_info, "About", "zenvqo.voice ke baare mein") {
            InfoActivity.open(this, InfoActivity.ABOUT)
        }
    }

    private fun addRow(box: LinearLayout, icon: Int, title: String, sub: String, onClick: () -> Unit) {
        if (box.childCount > 0) {
            box.addView(View(this).apply { setBackgroundColor(Color.parseColor("#FF22373A")) },
                LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 1).apply { marginStart = dp(56) })
        }
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), dp(14), dp(12), dp(14))
            foreground = themeDrawable(android.R.attr.selectableItemBackground)
            isClickable = true
            setOnClickListener { onClick() }
        }
        row.addView(ImageView(this).apply {
            setImageResource(icon)
            imageTintList = ColorStateList.valueOf(marigold)
        }, LinearLayout.LayoutParams(dp(22), dp(22)))
        val texts = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), 0, dp(8), 0)
        }
        texts.addView(TextView(this).apply {
            text = title
            textSize = 15f
            setTextColor(ContextCompat.getColor(context, R.color.text))
        })
        texts.addView(TextView(this).apply {
            text = sub
            textSize = 12f
            setTextColor(ContextCompat.getColor(context, R.color.muted))
        })
        row.addView(texts, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        row.addView(ImageView(this).apply {
            setImageResource(R.drawable.ic_chevron)
            imageTintList = ColorStateList.valueOf(ContextCompat.getColor(context, R.color.muted))
        }, LinearLayout.LayoutParams(dp(20), dp(20)))
        box.addView(row)
    }

    private fun open(vararg intents: Intent) {
        for (i in intents) {
            try { startActivity(i); return } catch (e: ActivityNotFoundException) { }
        }
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    private fun withAlpha(color: Int, a: Float): Int =
        Color.argb((a * 255).toInt(), Color.red(color), Color.green(color), Color.blue(color))

    private fun themeDrawable(attr: Int) = TypedValue().let { tv ->
        theme.resolveAttribute(attr, tv, true)
        ContextCompat.getDrawable(this, tv.resourceId)
    }

    companion object {
        fun isAutoTapOn(c: Context): Boolean {
            if (AutoTapService.isRunning()) return true
            val enabled = Settings.Secure.getString(c.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES)
                ?: return false
            return enabled.contains("${c.packageName}/") && enabled.contains("AutoTapService")
        }
    }
}
