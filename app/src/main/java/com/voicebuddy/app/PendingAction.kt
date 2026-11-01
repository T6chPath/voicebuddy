package com.voicebuddy.app

/** What the Auto-Tap service should press next. Valid only for a few seconds after a voice command. */
object PendingAction {

    sealed class Task {
        /** Press Send in the WhatsApp chat zenvqo.voice just opened. */
        object WhatsAppSend : Task()
        /** Start the first video in the YouTube results zenvqo.voice just opened. */
        object YouTubePlayFirst : Task()
        /** Flip the matching switch on the Settings screen/panel zenvqo.voice just opened, then go back. */
        data class ToggleSwitch(
            val on: Boolean,
            val keywords: List<String>,
            val excludes: List<String>,
            val firstSwitchOk: Boolean
        ) : Task()
        /** Press Send in an AI app (ChatGPT / Claude / Gemini) after sharing the question to it. */
        data class AppSend(val pkg: String) : Task()
        /** Open the app's search box, type the query and press search. */
        data class InAppSearch(val pkg: String, val query: String) : Task()
        /** A list of screen steps done one after another inside an app (WhatsApp reply, status, settings…). */
        class Flow(val pkgPrefix: String, val steps: List<Step>, val doneMessage: String? = null) : Task()
    }

    /** One step of a [Task.Flow]. Each step is retried until it works or [timeoutMs] passes. */
    data class Step(
        val kind: Kind,
        /** Button text / description to look for (lowercase). The first label is shown if the step fails. */
        val labels: List<String> = emptyList(),
        /** View ids inside the app, without the package ("send" = com.whatsapp:id/send). */
        val ids: List<String> = emptyList(),
        val text: String = "",
        /** true = label must match the whole text; false = "starts with" / "contains" also count. */
        val exact: Boolean = false,
        /** Skip this step (instead of stopping) when it can't be done. */
        val optional: Boolean = false,
        val ms: Long = 0,
        val timeoutMs: Long = 8_000,
        /** Scroll the list while looking for the label (settings screens). */
        val scroll: Boolean = false,
        /** For LONG_PRESS_MESSAGE: true = my message, false = their message, null = either. */
        val outgoing: Boolean? = null,
        /** For TAP: if nothing matches, tap the first item of the list instead. */
        val orFirst: Boolean = false,
        /** Run even when another app (system dialog) is on top. */
        val anyApp: Boolean = false
    ) {
        enum class Kind { TAP, LONG_PRESS_MESSAGE, TYPE, TYPE_EMPTY, FIRST_RESULT, HOLD, WAIT, ENTER, FINISH }

        companion object {
            fun tap(vararg labels: String, ids: List<String> = emptyList(), exact: Boolean = false,
                    optional: Boolean = false, timeoutMs: Long = 8_000, scroll: Boolean = false,
                    orFirst: Boolean = false, anyApp: Boolean = false) =
                Step(Kind.TAP, labels.toList(), ids, exact = exact, optional = optional, timeoutMs = timeoutMs,
                    scroll = scroll, orFirst = orFirst, anyApp = anyApp)
            fun longPressMessage(outgoing: Boolean?) = Step(Kind.LONG_PRESS_MESSAGE, listOf("message"), outgoing = outgoing)
            fun type(text: String, vararg hints: String, optional: Boolean = false) =
                Step(Kind.TYPE, hints.toList(), text = text, optional = optional)
            fun typeEmpty(text: String) = Step(Kind.TYPE_EMPTY, listOf("text box"), text = text)
            fun firstResult(optional: Boolean = false) = Step(Kind.FIRST_RESULT, listOf("result"), optional = optional, timeoutMs = 10_000)
            fun hold(ms: Long, vararg labels: String, ids: List<String> = emptyList()) =
                Step(Kind.HOLD, labels.toList(), ids, ms = ms)
            fun wait(ms: Long) = Step(Kind.WAIT, ms = ms)
            fun enter() = Step(Kind.ENTER, optional = true, timeoutMs = 2_000)
            /** Stops the flow here and shows [message] (used before steps the user must do himself). */
            fun finish(message: String) = Step(Kind.FINISH, text = message)
        }
    }

    @Volatile private var task: Task? = null
    @Volatile private var expiresAt = 0L

    fun set(t: Task, validForMs: Long = 15_000) {
        task = t
        expiresAt = System.currentTimeMillis() + validForMs
    }

    fun current(): Task? {
        if (System.currentTimeMillis() > expiresAt) task = null
        return task
    }

    fun clear() { task = null }
}
