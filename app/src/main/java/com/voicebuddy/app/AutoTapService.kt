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
        /** ⚡ switch OFF = paused: the permission stays granted, so ON is instant again later. */
        @Volatile var paused = false
        /** Ready to finish jobs by itself (permission granted and the ⚡ switch ON). */
        fun isRunning() = instance != null && !paused
    }

    private val handler = Handler(Looper.getMainLooper())
    @Volatile private var scheduled = false

    private var searchStep = 0
    private var searchTask: PendingAction.Task.InAppSearch? = null

    override fun onServiceConnected() {
        instance = this
        paused = !AutoTapHelper.wanted(this)
        AutoTapHelper.onServiceStarted(this)
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
        if (paused) return
        val task = PendingAction.current() ?: return
        if (task is PendingAction.Task.Flow) { if (!flowRunning) kickFlow(); return }
        val pkg = event?.packageName?.toString() ?: return
        if (pkg == packageName || scheduled) return
        scheduled = true
        val delay = when (task) {
            PendingAction.Task.WhatsAppSend -> 400L
            PendingAction.Task.YouTubePlayFirst -> 900L
            is PendingAction.Task.ToggleSwitch -> 700L
            is PendingAction.Task.AppSend -> 1000L
            is PendingAction.Task.InAppSearch -> 1200L
            is PendingAction.Task.Flow -> return
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
            is PendingAction.Task.Flow -> Unit
        }
    }

    // ---------- Multi-step flows (WhatsApp reply, status, settings…) ----------
    private var flow: PendingAction.Task.Flow? = null
    private var flowIdx = 0
    private var stepStart = 0L
    private var stepTries = 0
    @Volatile private var flowRunning = false
    private val flowTick = Runnable { tickFlow() }

    /** Starts (or restarts) working on the current flow. Called right after zenvqo.voice sets one. */
    fun kickFlow() {
        handler.removeCallbacks(flowTick)
        flowRunning = true
        handler.postDelayed(flowTick, 900)
    }

    private fun tickFlow() {
        val task = PendingAction.current() as? PendingAction.Task.Flow
        if (task == null) { flowRunning = false; flow = null; return }
        if (flow !== task) { flow = task; flowIdx = 0; stepStart = System.currentTimeMillis(); stepTries = 0 }
        if (flowIdx >= task.steps.size) { endFlow(task.doneMessage); return }

        val step = task.steps[flowIdx]
        val now = System.currentTimeMillis()
        if (step.kind == PendingAction.Step.Kind.FINISH) { endFlow(step.text); return }

        val root = rootInActiveWindow
        val rootPkg = root?.packageName?.toString() ?: ""
        val rightApp = step.anyApp || rootPkg.startsWith(task.pkgPrefix)
        stepTries++
        var nextDelay = 450L
        val done = when {
            step.kind == PendingAction.Step.Kind.WAIT -> now - stepStart >= step.ms
            root == null || !rightApp -> false
            else -> try { runStep(root, step).also { if (it && step.kind == PendingAction.Step.Kind.HOLD) nextDelay = step.ms + 1200 } }
                    catch (e: Exception) { false }
        }

        if (done) {
            flowIdx++
            stepStart = System.currentTimeMillis()
            stepTries = 0
            if (nextDelay == 450L) nextDelay = 750L
        } else if (now - stepStart > step.timeoutMs) {
            if (step.optional) {
                flowIdx++; stepStart = System.currentTimeMillis(); stepTries = 0
            } else {
                val what = step.labels.firstOrNull() ?: "next step"
                endFlow("WhatsApp mein \"$what\" nahi mila. Ye step aap khud kar lijiye.")
                return
            }
        }
        if (flowIdx >= task.steps.size) { endFlow(task.doneMessage); return }
        handler.postDelayed(flowTick, nextDelay)
    }

    private fun endFlow(message: String?) {
        PendingAction.clear()
        flow = null
        flowRunning = false
        handler.removeCallbacks(flowTick)
        if (!message.isNullOrBlank()) android.widget.Toast.makeText(this, message, android.widget.Toast.LENGTH_LONG).show()
    }

    private fun runStep(root: AccessibilityNodeInfo, step: PendingAction.Step): Boolean {
        val pkg = root.packageName?.toString() ?: ""
        return when (step.kind) {
            PendingAction.Step.Kind.TAP -> {
                val node = findLabeled(root, pkg, step.labels, step.ids, step.exact)
                if (node != null) return pressNode(node)
                val elapsed = System.currentTimeMillis() - stepStart
                if (step.orFirst && elapsed > step.timeoutMs / 2) return firstResult(root)
                if (step.scroll && stepTries % 2 == 0) scrollBiggest(root, true)
                false
            }
            PendingAction.Step.Kind.LONG_PRESS_MESSAGE -> longPressMessage(root, step.outgoing)
            PendingAction.Step.Kind.TYPE -> {
                val field = findField(root, step.labels) ?: return false
                if (!field.isFocused) field.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                setText(field, step.text)
            }
            PendingAction.Step.Kind.TYPE_EMPTY -> {
                val edits = mutableListOf<AccessibilityNodeInfo>()
                collect(root, edits) { it.isEditable && it.isVisibleToUser }
                val field = edits.firstOrNull { it.text.isNullOrBlank() || it.isShowingHintTextCompat() } ?: return false
                field.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                setText(field, step.text)
            }
            PendingAction.Step.Kind.FIRST_RESULT -> firstResult(root)
            PendingAction.Step.Kind.HOLD -> {
                val node = findLabeled(root, pkg, step.labels, step.ids, false) ?: return false
                val r = Rect()
                node.getBoundsInScreen(r)
                holdAt(r.exactCenterX(), r.exactCenterY(), step.ms)
            }
            PendingAction.Step.Kind.ENTER -> { pressEnter(); true }
            PendingAction.Step.Kind.WAIT, PendingAction.Step.Kind.FINISH -> true
        }
    }

    /** Best visible button/item for the labels (exact text first), or by view id. Text boxes are skipped. */
    private fun findLabeled(
        root: AccessibilityNodeInfo, pkg: String, labels: List<String>, ids: List<String>, exact: Boolean
    ): AccessibilityNodeInfo? {
        for (id in ids) {
            root.findAccessibilityNodeInfosByViewId("$pkg:id/$id").firstOrNull { it.isVisibleToUser }?.let { return it }
        }
        if (labels.isEmpty()) return null
        val wanted = labels.map { it.lowercase().trim() }
        var best: AccessibilityNodeInfo? = null
        var bestScore = 0
        val nodes = mutableListOf<AccessibilityNodeInfo>()
        collect(root, nodes) { n ->
            n.isVisibleToUser && !n.isEditable && (!n.text.isNullOrBlank() || !n.contentDescription.isNullOrBlank())
        }
        for (n in nodes) {
            for (raw in listOf(n.text, n.contentDescription)) {
                val t = raw?.toString()?.lowercase()?.trim() ?: continue
                if (t.isEmpty() || t.length > 90) continue
                for (w in wanted) {
                    val score = when {
                        t == w -> 4
                        exact -> 0
                        t.startsWith("$w ") || t.startsWith("$w,") -> 3
                        Regex("(^|\\W)${Regex.escape(w)}(\\W|$)").containsMatchIn(t) -> 2
                        w.length >= 4 && t.contains(w) -> 1
                        else -> 0
                    }
                    if (score > bestScore) { bestScore = score; best = n }
                }
            }
        }
        return best
    }

    private fun pressNode(node: AccessibilityNodeInfo): Boolean {
        if (clickUp(node)) return true
        val r = Rect()
        node.getBoundsInScreen(r)
        return tapAt(r.exactCenterX(), r.exactCenterY())
    }

    private fun findField(root: AccessibilityNodeInfo, hints: List<String>): AccessibilityNodeInfo? {
        val edits = mutableListOf<AccessibilityNodeInfo>()
        collect(root, edits) { it.isEditable && it.isVisibleToUser }
        if (edits.isEmpty()) return null
        if (hints.isNotEmpty()) {
            edits.firstOrNull { e ->
                val hint = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) e.hintText?.toString() ?: "" else ""
                val all = (hint + " " + (e.text ?: "") + " " + (e.contentDescription ?: "") + " " + (e.viewIdResourceName ?: "")).lowercase()
                hints.any { all.contains(it) }
            }?.let { return it }
        }
        return edits.firstOrNull { it.isFocused } ?: edits.first()
    }

    /** First item of the list/grid under the search box (first GIF, sticker, song, file, wallpaper…). */
    private fun firstResult(root: AccessibilityNodeInfo): Boolean {
        val edits = mutableListOf<AccessibilityNodeInfo>()
        collect(root, edits) { it.isEditable && it.isVisibleToUser }
        val floor = edits.maxOfOrNull { Rect().also { r -> it.getBoundsInScreen(r) }.bottom } ?: 0
        val items = mutableListOf<AccessibilityNodeInfo>()
        collect(root, items) { n ->
            if (!n.isVisibleToUser || !n.isClickable || n.isEditable) return@collect false
            val r = Rect().also { n.getBoundsInScreen(it) }
            r.top >= floor && r.width() > 40 && r.height() > 40 && insideScrollable(n)
        }
        val first = items.minWithOrNull(compareBy<AccessibilityNodeInfo>(
            { Rect().also { r -> it.getBoundsInScreen(r) }.top / 40 },
            { Rect().also { r -> it.getBoundsInScreen(r) }.left }
        )) ?: return false
        return pressNode(first)
    }

    private fun insideScrollable(n: AccessibilityNodeInfo): Boolean {
        var p = n.parent
        var i = 0
        while (p != null && i < 10) {
            if (p.isScrollable) return true
            p = p.parent; i++
        }
        return false
    }

    /**
     * Long-presses the newest chat bubble. My messages sit on the right, theirs on the left,
     * date/system notes in the middle (skipped).
     */
    private fun longPressMessage(root: AccessibilityNodeInfo, outgoing: Boolean?): Boolean {
        val width = resources.displayMetrics.widthPixels
        val pkg = root.packageName?.toString() ?: ""
        var bubbles = listOf("message_text", "caption", "conversation_text_row").flatMap {
            root.findAccessibilityNodeInfosByViewId("$pkg:id/$it")
        }.filter { it.isVisibleToUser }
        if (bubbles.isEmpty()) {
            val lists = mutableListOf<AccessibilityNodeInfo>()
            collect(root, lists) { it.isScrollable && it.isVisibleToUser }
            val chat = lists.maxByOrNull { n -> Rect().also { n.getBoundsInScreen(it) }.let { it.height() } } ?: return false
            val texts = mutableListOf<AccessibilityNodeInfo>()
            collect(chat, texts) { it.isVisibleToUser && !it.text.isNullOrBlank() && !it.isEditable }
            bubbles = texts
        }
        val picked = bubbles.mapNotNull { n ->
            val r = Rect().also { n.getBoundsInScreen(it) }
            val left = r.left
            val right = width - r.right
            if (kotlin.math.abs(left - right) < width * 0.08) return@mapNotNull null   // centred = date / system note
            val mine = right < left
            if (outgoing != null && mine != outgoing) null else n to r
        }.maxByOrNull { it.second.bottom } ?: return false

        var n: AccessibilityNodeInfo? = picked.first
        while (n != null) {
            if (n.isLongClickable) return n.performAction(AccessibilityNodeInfo.ACTION_LONG_CLICK)
            n = n.parent
        }
        return holdAt(picked.second.exactCenterX(), picked.second.exactCenterY(), 800)
    }

    private fun scrollBiggest(root: AccessibilityNodeInfo, down: Boolean) {
        val list = mutableListOf<AccessibilityNodeInfo>()
        collect(root, list) { it.isScrollable && it.isVisibleToUser }
        list.maxByOrNull { n -> Rect().also { n.getBoundsInScreen(it) }.let { it.width() * it.height() } }
            ?.performAction(if (down) AccessibilityNodeInfo.ACTION_SCROLL_FORWARD else AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD)
    }

    /** Press and hold (voice / video note recording). */
    private fun holdAt(x: Float, y: Float, ms: Long): Boolean {
        val path = Path().apply { moveTo(x, y) }
        val max = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) GestureDescription.getMaxGestureDuration() else 60_000L
        val g = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, ms.coerceAtMost(max - 100)))
            .build()
        return dispatchGesture(g, null, null)
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
