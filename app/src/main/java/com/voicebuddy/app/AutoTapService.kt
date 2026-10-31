package com.voicebuddy.app

import android.accessibilityservice.AccessibilityButtonController
import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Intent
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

/**
 * Presses one button for you, only right after your own voice command:
 *  - WhatsApp: the Send button in the chat zenvqo.voice just opened
 *  - YouTube: the first video in the search results zenvqo.voice just opened
 *  - Settings: the Wi-Fi / Bluetooth / mobile data / hotspot switch zenvqo.voice just opened
 *  - ChatGPT / Claude / Gemini: Send, after zenvqo.voice shares your question
 *  - Any app: press a button by its name, type text, scroll, use the app's search box
 * It also performs screenshot / lock / home when you ask, and shows the floating
 * zenvqo.voice button so you can talk from inside any app. It does nothing on its own.
 */
class AutoTapService : AccessibilityService() {

    companion object {
        @Volatile var instance: AutoTapService? = null
            private set
        fun isRunning() = instance != null
    }

    private val handler = Handler(Looper.getMainLooper())
    @Volatile private var scheduled = false

    private var searchStep = 0
    private var searchTask: PendingAction.Task.InAppSearch? = null

    override fun onServiceConnected() {
        instance = this
        // Floating accessibility button / nav-bar button -> talk to zenvqo.voice from any app
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            accessibilityButtonController.registerAccessibilityButtonCallback(
                object : AccessibilityButtonController.AccessibilityButtonCallback() {
                    override fun onClicked(controller: AccessibilityButtonController) {
                        openListener()
                    }
                }
            )
        }
    }

    fun openListener() {
        startActivity(
            Intent(this, MainActivity::class.java)
                .setAction(MainActivity.ACTION_LISTEN)
                .putExtra(MainActivity.EXTRA_FROM_BUTTON, true)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
    }

    override fun onUnbind(intent: Intent?): Boolean {
        instance = null
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        instance = null
        super.onDestroy()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        val task = PendingAction.current() ?: return
        val pkg = event?.packageName?.toString() ?: return
        if (pkg == packageName || scheduled) return
        scheduled = true
        val delay = when (task) {
            PendingAction.Task.WhatsAppSend -> 400L
            PendingAction.Task.YouTubePlayFirst -> 900L
            is PendingAction.Task.ToggleSwitch -> 700L
            is PendingAction.Task.AppSend -> 1000L
            is PendingAction.Task.InAppSearch -> 1200L
        }
        handler.postDelayed({
            scheduled = false
            act(task)
        }, delay)
    }

    private fun act(task: PendingAction.Task) {
        if (PendingAction.current() != task) return
        val root = rootInActiveWindow ?: return
        val rootPkg = root.packageName?.toString() ?: return
        when (task) {
            PendingAction.Task.WhatsAppSend ->
                if (rootPkg.startsWith("com.whatsapp")) whatsAppSend(root, rootPkg)
            PendingAction.Task.YouTubePlayFirst ->
                if (rootPkg == "com.google.android.youtube") youTubeFirst(root)
            is PendingAction.Task.ToggleSwitch ->
                if (rootPkg.contains("settings") || rootPkg.contains("systemui")) toggle(root, task)
            is PendingAction.Task.AppSend ->
                if (rootPkg == task.pkg) appSend(root)
            is PendingAction.Task.InAppSearch ->
                if (rootPkg == task.pkg) inAppSearch(root, task)
        }
    }

    // ---------- Search inside an app ----------
    private fun inAppSearch(root: AccessibilityNodeInfo, task: PendingAction.Task.InAppSearch) {
        if (searchTask != task) { searchTask = task; searchStep = 0 }
        val field = findSearchField(root)
        if (field != null) {
            if (!field.isFocused) field.performAction(AccessibilityNodeInfo.ACTION_CLICK)
            if (setText(field, task.query)) {
                PendingAction.clear()
                handler.postDelayed({ pressEnter() }, 500)
            }
            return
        }
        if (searchStep < 3) {
            searchStep++
            val opener = findNode(root) {
                val t = (it.text?.toString() ?: "") + " " + (it.contentDescription?.toString() ?: "")
                val id = it.viewIdResourceName?.lowercase() ?: ""
                it.isVisibleToUser && (t.lowercase().contains("search") || id.contains("search"))
            }
            opener?.let { clickUp(it) }
        }
    }

    private fun findSearchField(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        val edits = mutableListOf<AccessibilityNodeInfo>()
        collect(root, edits) { it.isEditable && it.isVisibleToUser }
        if (edits.isEmpty()) return null
        return edits.firstOrNull {
            val hint = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) it.hintText?.toString() ?: "" else ""
            val all = (hint + " " + (it.text ?: "") + " " + (it.contentDescription ?: "") + " " +
                (it.viewIdResourceName ?: "")).lowercase()
            all.contains("search")
        } ?: edits.firstOrNull { it.isFocused } ?: if (edits.size == 1) edits.first() else null
    }

    private fun pressEnter() {
        val root = rootInActiveWindow ?: return
        val focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            focused.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id)
        }
    }

    // ---------- Work inside the app on screen (called right after zenvqo.voice steps aside) ----------
    /** Presses the button / item whose label best matches [target]. */
    fun tapOnText(target: String): Boolean {
        val root = rootInActiveWindow ?: return false
        if (root.packageName?.toString() == packageName) return false
        val want = NameMatch.clean(target)
        val nodes = mutableListOf<AccessibilityNodeInfo>()
        collect(root, nodes) { n ->
            n.isVisibleToUser && (!n.text.isNullOrBlank() || !n.contentDescription.isNullOrBlank())
        }
        var best: AccessibilityNodeInfo? = null
        var bestScore = 0
        for (n in nodes) {
            val label = NameMatch.clean((n.text ?: n.contentDescription ?: "").toString())
            if (label.isEmpty() || label.length > 60) continue
            val score = when {
                label == want -> 20
                label.startsWith(want) -> 12
                label.split(" ").contains(want) -> 10
                label.contains(want) -> 6
                else -> NameMatch.score(want, label)
            }
            if (score > bestScore) { bestScore = score; best = n }
        }
        val node = best ?: return false
        if (clickUp(node)) return true
        val r = Rect()
        node.getBoundsInScreen(r)
        return tapAt(r.exactCenterX(), r.exactCenterY())
    }

    /** Types into the focused text box (or the only one on screen). */
    fun typeText(text: String): Boolean {
        val root = rootInActiveWindow ?: return false
        if (root.packageName?.toString() == packageName) return false
        val field = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)?.takeIf { it.isEditable }
            ?: run {
                val edits = mutableListOf<AccessibilityNodeInfo>()
                collect(root, edits) { it.isEditable && it.isVisibleToUser }
                edits.firstOrNull()
            } ?: return false
        if (!field.isFocused) field.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        val existing = field.text?.toString().orEmpty()
        val hint = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) field.hintText?.toString() else null
        val keep = existing.isNotBlank() && existing != hint && !field.isShowingHintTextCompat()
        return setText(field, if (keep) "$existing $text" else text)
    }

    private fun AccessibilityNodeInfo.isShowingHintTextCompat(): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && isShowingHintText

    /** Scrolls the main list on screen; falls back to a swipe. */
    fun scroll(down: Boolean): Boolean {
        val root = rootInActiveWindow ?: return false
        if (root.packageName?.toString() == packageName) return false
        val scrollables = mutableListOf<AccessibilityNodeInfo>()
        collect(root, scrollables) { it.isScrollable && it.isVisibleToUser }
        val biggest = scrollables.maxByOrNull { n -> Rect().also { n.getBoundsInScreen(it) }.let { it.width() * it.height() } }
        val action = if (down) AccessibilityNodeInfo.ACTION_SCROLL_FORWARD else AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
        if (biggest != null && biggest.performAction(action)) return true
        val dm = resources.displayMetrics
        val x = dm.widthPixels / 2f
        val (y1, y2) = if (down) dm.heightPixels * 0.75f to dm.heightPixels * 0.3f
        else dm.heightPixels * 0.3f to dm.heightPixels * 0.75f
        return swipe(x, y1, x, y2)
    }

    private fun setText(field: AccessibilityNodeInfo, text: String): Boolean {
        val args = Bundle()
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        return field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
    }

    private fun tapAt(x: Float, y: Float): Boolean {
        val path = Path().apply { moveTo(x, y) }
        val g = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, 60))
            .build()
        return dispatchGesture(g, null, null)
    }

    private fun swipe(x1: Float, y1: Float, x2: Float, y2: Float): Boolean {
        val path = Path().apply { moveTo(x1, y1); lineTo(x2, y2) }
        val g = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, 350))
            .build()
        return dispatchGesture(g, null, null)
    }

    private fun whatsAppSend(root: AccessibilityNodeInfo, pkg: String) {
        val send = root.findAccessibilityNodeInfosByViewId("$pkg:id/send").firstOrNull()
            ?: findNode(root) { it.contentDescription?.toString()?.equals("Send", true) == true }
        if (send != null && clickUp(send)) PendingAction.clear()
    }

    private fun youTubeFirst(root: AccessibilityNodeInfo) {
        // YouTube labels each result like "<title> - 4 minutes, 28 seconds - Go to channel - ... - play video"
        val first = findNode(root) {
            val d = it.contentDescription?.toString()?.lowercase() ?: return@findNode false
            d.contains("play video") || (d.contains("views") && (d.contains("minute") || d.contains("second")))
        }
        if (first != null && clickUp(first)) PendingAction.clear()
    }

    private fun appSend(root: AccessibilityNodeInfo) {
        val send = findNode(root) {
            val id = it.viewIdResourceName?.lowercase() ?: ""
            val d = it.contentDescription?.toString()?.lowercase()?.trim() ?: ""
            it.isEnabled && (id.endsWith("/send") || id.contains("send_button") ||
                d == "send" || d == "send message" || d == "send prompt" || d == "submit")
        }
        if (send != null && clickUp(send)) PendingAction.clear()
    }

    // ---------- Settings switches ----------
    private fun isSwitch(n: AccessibilityNodeInfo): Boolean {
        val cls = n.className?.toString() ?: ""
        if (cls.contains("CheckBox") || cls.contains("RadioButton")) return false
        return cls.contains("Switch") || cls.contains("ToggleButton") || (n.isCheckable && cls.contains("Compound"))
    }

    private fun toggle(root: AccessibilityNodeInfo, task: PendingAction.Task.ToggleSwitch) {
        val switches = mutableListOf<AccessibilityNodeInfo>()
        collect(root, switches) { isSwitch(it) }
        if (switches.isEmpty()) return

        var target: AccessibilityNodeInfo? = null
        for (sw in switches) {
            val ctx = contextText(sw)
            if (task.excludes.any { ctx.contains(it) }) continue
            if (task.keywords.any { ctx.contains(it) }) { target = sw; break }
        }
        if (target == null && task.firstSwitchOk) target = switches.first()
        val sw = target ?: return

        if (sw.isChecked != task.on) clickUp(sw)
        PendingAction.clear()
        handler.postDelayed({ performGlobalAction(GLOBAL_ACTION_BACK) }, 900)
    }

    /** Text of the row around a switch (its label), stopping before the row would include another switch. */
    private fun contextText(sw: AccessibilityNodeInfo): String {
        var node = sw
        var text = collectText(sw, 0)
        for (i in 1..3) {
            val parent = node.parent ?: break
            if (countSwitches(parent, 0) > 1) break
            node = parent
            text = collectText(parent, 0)
        }
        return text.lowercase()
    }

    private fun countSwitches(n: AccessibilityNodeInfo?, depth: Int): Int {
        if (n == null || depth > 6) return 0
        var c = if (isSwitch(n)) 1 else 0
        for (i in 0 until n.childCount) c += countSwitches(n.getChild(i), depth + 1)
        return c
    }

    private fun collectText(n: AccessibilityNodeInfo?, depth: Int): String {
        if (n == null || depth > 6) return ""
        val sb = StringBuilder()
        n.text?.let { sb.append(it).append(' ') }
        n.contentDescription?.let { sb.append(it).append(' ') }
        for (i in 0 until n.childCount) sb.append(collectText(n.getChild(i), depth + 1))
        return sb.toString()
    }

    // ---------- helpers ----------
    private fun collect(
        n: AccessibilityNodeInfo?,
        out: MutableList<AccessibilityNodeInfo>,
        test: (AccessibilityNodeInfo) -> Boolean
    ) {
        if (n == null) return
        if (test(n)) out.add(n)
        for (i in 0 until n.childCount) collect(n.getChild(i), out, test)
    }

    private fun findNode(n: AccessibilityNodeInfo?, test: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo? {
        if (n == null) return null
        if (test(n)) return n
        for (i in 0 until n.childCount) findNode(n.getChild(i), test)?.let { return it }
        return null
    }

    /** Clicks the node, or the nearest clickable parent. */
    private fun clickUp(node: AccessibilityNodeInfo): Boolean {
        var n: AccessibilityNodeInfo? = node
        while (n != null) {
            if (n.isClickable) return n.performAction(AccessibilityNodeInfo.ACTION_CLICK)
            n = n.parent
        }
        return false
    }

    override fun onInterrupt() = Unit
}
