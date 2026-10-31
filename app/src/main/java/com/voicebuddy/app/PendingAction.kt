package com.voicebuddy.app

/** What the Auto-Tap service should press next, valid only for a few seconds after a command. */
object PendingAction {
    enum class Kind { NONE, WHATSAPP_SEND, YOUTUBE_PLAY_FIRST }

    @Volatile var kind: Kind = Kind.NONE
        private set
    @Volatile private var expiresAt = 0L

    fun set(k: Kind, validForMs: Long = 15_000) {
        kind = k
        expiresAt = System.currentTimeMillis() + validForMs
    }

    fun current(): Kind {
        if (System.currentTimeMillis() > expiresAt) kind = Kind.NONE
        return kind
    }

    fun clear() { kind = Kind.NONE }
}
