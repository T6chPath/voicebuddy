package com.voicebuddy.app

/** What the Auto-Tap service should press next. Valid only for a few seconds after a voice command. */
object PendingAction {

    sealed class Task {
        /** Press Send in the WhatsApp chat VoiceBuddy just opened. */
        object WhatsAppSend : Task()
        /** Start the first video in the YouTube results VoiceBuddy just opened. */
        object YouTubePlayFirst : Task()
        /** Flip the matching switch on the Settings screen/panel VoiceBuddy just opened, then go back. */
        data class ToggleSwitch(
            val on: Boolean,
            val keywords: List<String>,
            val excludes: List<String>,
            val firstSwitchOk: Boolean
        ) : Task()
        /** Press Send in an AI app (ChatGPT / Claude / Gemini) after sharing the question to it. */
        data class AppSend(val pkg: String) : Task()
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
