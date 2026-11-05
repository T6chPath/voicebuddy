package com.voicebuddy.app

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.PixelFormat
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.view.animation.DecelerateInterpolator
import android.widget.ImageView
import android.widget.Toast
import kotlin.math.abs

/**
 * The crowned bird floating over every app. Tap it → zenvqo.voice listens, and your command
 * runs in the app underneath ("like karo", "download karo"…). Drag it anywhere; it snaps to the
 * nearest side. Long-press hides it until zenvqo.voice is opened again.
 *
 * Drawn by the accessibility service as an accessibility overlay, so no extra permission is needed.
 */
class BirdBubble(private val ctx: Context, private val onTap: () -> Unit) {

    companion object {
        private const val PREFS = "bubble"
        private const val KEY_ENABLED = "enabled"
        private const val KEY_X = "x"
        private const val KEY_Y = "y"

        fun isEnabled(c: Context) = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_ENABLED, true)
        fun setEnabled(c: Context, on: Boolean) =
            c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_ENABLED, on).apply()
    }

    private val wm = ctx.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    private val d = ctx.resources.displayMetrics.density
    private val size = (58 * d).toInt()
    private var view: ImageView? = null
    private var params: WindowManager.LayoutParams? = null
    /** Hidden by long-press; shown again when the app is opened. */
    var snoozed = false

    val isShowing get() = view != null

    @SuppressLint("ClickableViewAccessibility")
    fun show() {
        if (view != null || snoozed || !isEnabled(ctx)) return
        val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val lp = WindowManager.LayoutParams(
            size, size,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = p.getInt(KEY_X, ctx.resources.displayMetrics.widthPixels - size - (6 * d).toInt())
            y = p.getInt(KEY_Y, (ctx.resources.displayMetrics.heightPixels * 0.55f).toInt())
        }
        val iv = ImageView(ctx).apply {
            setImageResource(R.drawable.bird_avatar)
            setBackgroundResource(R.drawable.bubble_ring)
            val pad = (3 * d).toInt()
            setPadding(pad, pad, pad, pad)
            elevation = 8 * d
            contentDescription = "zenvqo.voice — bolne ke liye tap karo"
            alpha = 0.95f
        }

        var downX = 0f; var downY = 0f; var startX = 0; var startY = 0
        var moved = false
        var longPressed = false
        val longPress = Runnable {
            if (!moved) {
                longPressed = true
                iv.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
                snoozed = true
                hide()
                Toast.makeText(ctx, "Chidiya chhupa di. zenvqo.voice kholne par wapas aayegi.", Toast.LENGTH_SHORT).show()
            }
        }
        iv.setOnTouchListener { v, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = e.rawX; downY = e.rawY; startX = lp.x; startY = lp.y
                    moved = false; longPressed = false
                    v.animate().scaleX(0.9f).scaleY(0.9f).setDuration(80).start()
                    v.postDelayed(longPress, 650)
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = e.rawX - downX; val dy = e.rawY - downY
                    if (!moved && (abs(dx) > 10 * d || abs(dy) > 10 * d)) { moved = true; v.removeCallbacks(longPress) }
                    if (moved) {
                        lp.x = startX + dx.toInt(); lp.y = startY + dy.toInt()
                        try { wm.updateViewLayout(v, lp) } catch (ex: Exception) { }
                    }
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    v.removeCallbacks(longPress)
                    v.animate().scaleX(1f).scaleY(1f).setDuration(120).start()
                    if (longPressed) return@setOnTouchListener true
                    if (moved) snapToEdge(v, lp)
                    else if (e.actionMasked == MotionEvent.ACTION_UP) {
                        v.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
                        onTap()
                    }
                }
            }
            true
        }
        try {
            wm.addView(iv, lp)
            view = iv; params = lp
            iv.scaleX = 0.3f; iv.scaleY = 0.3f
            iv.animate().scaleX(1f).scaleY(1f).setDuration(220).setInterpolator(DecelerateInterpolator()).start()
        } catch (e: Exception) {
            view = null
        }
    }

    fun hide() {
        val v = view ?: return
        try { wm.removeView(v) } catch (e: Exception) { }
        view = null
    }

    /** Hide while our own screen is up, show again elsewhere. */
    fun setVisibleNow(visible: Boolean) {
        view?.visibility = if (visible) View.VISIBLE else View.GONE
    }

    private fun snapToEdge(v: View, lp: WindowManager.LayoutParams) {
        val w = ctx.resources.displayMetrics.widthPixels
        val h = ctx.resources.displayMetrics.heightPixels
        val margin = (6 * d).toInt()
        val targetX = if (lp.x + size / 2 < w / 2) margin else w - size - margin
        lp.y = lp.y.coerceIn((40 * d).toInt(), h - size - (60 * d).toInt())
        ValueAnimator.ofInt(lp.x, targetX).apply {
            duration = 200
            interpolator = DecelerateInterpolator()
            addUpdateListener {
                lp.x = it.animatedValue as Int
                try { wm.updateViewLayout(v, lp) } catch (e: Exception) { }
            }
            start()
        }
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putInt(KEY_X, targetX).putInt(KEY_Y, lp.y).apply()
    }
}
