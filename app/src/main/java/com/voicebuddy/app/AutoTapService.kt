package com.voicebuddy.app

import android.accessibilityservice.AccessibilityService
import android.os.Handler
import android.os.Looper
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

/**
 * Presses one button for you, only right after your own voice command:
 *  - WhatsApp: the Send button in the chat VoiceBuddy just opened
 *  - YouTube: the first video in the search results VoiceBuddy just opened
 * It does nothing at any other time.
 */
class AutoTapService : AccessibilityService() {

    private val handler = Handler(Looper.getMainLooper())

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        val pkg = event?.packageName?.toString() ?: return
        when (PendingAction.current()) {
            PendingAction.Kind.WHATSAPP_SEND ->
                if (pkg.startsWith("com.whatsapp")) handler.postDelayed({ tryWhatsAppSend(pkg) }, 400)
            PendingAction.Kind.YOUTUBE_PLAY_FIRST ->
                if (pkg == "com.google.android.youtube") handler.postDelayed({ tryYouTubeFirst() }, 900)
            PendingAction.Kind.NONE -> Unit
        }
    }

    private fun tryWhatsAppSend(pkg: String) {
        if (PendingAction.current() != PendingAction.Kind.WHATSAPP_SEND) return
        val root = rootInActiveWindow ?: return
        val send = root.findAccessibilityNodeInfosByViewId("$pkg:id/send").firstOrNull()
            ?: findNode(root) { it.contentDescription?.toString()?.equals("Send", true) == true }
        if (send != null && clickUp(send)) PendingAction.clear()
    }

    private fun tryYouTubeFirst() {
        if (PendingAction.current() != PendingAction.Kind.YOUTUBE_PLAY_FIRST) return
        val root = rootInActiveWindow ?: return
        // YouTube labels each result like "<title> - 4 minutes - Go to channel - ... - play video"
        val first = findNode(root) {
            it.contentDescription?.toString()?.contains("play video", ignoreCase = true) == true
        }
        if (first != null && clickUp(first)) PendingAction.clear()
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
