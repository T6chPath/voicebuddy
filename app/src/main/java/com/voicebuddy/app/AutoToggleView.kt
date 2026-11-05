package com.voicebuddy.app

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.util.AttributeSet
import android.view.View
import android.view.animation.DecelerateInterpolator
import androidx.core.content.ContextCompat

/**
 * A small pill switch like YouTube's "Autoplay" toggle: a white knob with a ⚡ on it slides
 * right (gold track = ON, everything happens by itself) or left (faint track = OFF).
 */
class AutoToggleView @JvmOverloads constructor(
    context: Context, attrs: AttributeSet? = null
) : View(context, attrs) {

    var isOn = false
        private set

    /** Called when the user flips it (not when [setOn] is called from code). */
    var onToggle: ((Boolean) -> Unit)? = null

    private var pos = 0f   // 0 = left (off), 1 = right (on)
    private val d = resources.displayMetrics.density
    private val track = Paint(Paint.ANTI_ALIAS_FLAG)
    private val knob = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        setShadowLayer(3 * d, 0f, 1 * d, 0x55000000)
    }
    private val bolt = ContextCompat.getDrawable(context, R.drawable.ic_bolt)!!.mutate()
    private val rect = RectF()
    private var anim: ValueAnimator? = null

    init {
        setLayerType(LAYER_TYPE_SOFTWARE, null)   // for the knob shadow
        isClickable = true
        isFocusable = true
        contentDescription = "Apne aap mode"
        setOnClickListener { flip() }
    }

    fun setOn(on: Boolean, animate: Boolean = true) {
        isOn = on
        stateDescriptionCompat()
        val target = if (on) 1f else 0f
        anim?.cancel()
        if (!animate || !isLaidOut) { pos = target; invalidate(); return }
        anim = ValueAnimator.ofFloat(pos, target).apply {
            duration = 180
            interpolator = DecelerateInterpolator()
            addUpdateListener { pos = it.animatedValue as Float; invalidate() }
            start()
        }
    }

    private fun flip() {
        setOn(!isOn)
        performHapticFeedback(android.view.HapticFeedbackConstants.VIRTUAL_KEY)
        onToggle?.invoke(isOn)
    }

    private fun stateDescriptionCompat() {
        if (android.os.Build.VERSION.SDK_INT >= 30) stateDescription = if (isOn) "On" else "Off"
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) =
        setMeasuredDimension((52 * d).toInt(), (46 * d).toInt())

    override fun onDraw(c: Canvas) {
        val h = 22 * d
        val top = (height - h) / 2
        rect.set(2 * d, top, width - 2 * d, top + h)
        // track: faint white (off) -> crown gold (on)
        track.color = blend(0x40FFFFFF, 0xFFFFC233.toInt(), pos)
        c.drawRoundRect(rect, h / 2, h / 2, track)
        // knob, a little bigger than the track, like YouTube's
        val r = 13 * d
        val cx = rect.left + r - 2 * d + (rect.width() - 2 * r + 4 * d) * pos
        val cy = height / 2f
        c.drawCircle(cx, cy, r, knob)
        // ⚡ on the knob: grey (off) -> royal blue (on)
        bolt.setTint(blend(0xFF9AA8BF.toInt(), 0xFF1257E0.toInt(), pos))
        val b = (8 * d).toInt()
        bolt.setBounds((cx - b).toInt(), (cy - b).toInt(), (cx + b).toInt(), (cy + b).toInt())
        bolt.draw(c)
    }

    private fun blend(a: Int, b: Int, t: Float): Int {
        fun ch(shift: Int) = (((a ushr shift) and 0xFF) * (1 - t) + ((b ushr shift) and 0xFF) * t).toInt() shl shift
        return ch(24) or ch(16) or ch(8) or ch(0)
    }
}
