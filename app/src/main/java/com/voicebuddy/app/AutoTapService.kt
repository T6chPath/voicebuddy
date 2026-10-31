package com.voicebuddy.app

import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

/**
 * Presses one button for you, only right after your own voice command:
 *  - WhatsApp: the Send button in the chat VoiceBuddy just opened
 *  - YouTube: the first video in the search results VoiceBuddy just opened
 *  - Settings: the Wi-Fi / Bluetooth / mobile data / hotspot switch VoiceBuddy just opened
 *  - ChatGPT / Claude / Gemini: Send, after VoiceBuddy shares your question
 * It also performs screenshot / lock / home when you ask. It does nothing at any other time.
 */
class AutoTapService : AccessibilityService() {

    companion object {
        @Volatile var instance: AutoTapService? = null
            private set
        fun isRunning() = instance != null
    }

    private val handler = Handler(Looper.getMainLooper())
    @Volatile private var scheduled = false

    override fun onServiceConnected() {
        instance = this
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
        }
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
