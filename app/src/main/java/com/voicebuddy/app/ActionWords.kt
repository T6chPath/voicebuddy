package com.voicebuddy.app

/**
 * Turns a spoken action ("like karo", "download", "share", "aage badho") into the button labels
 * that app shows on screen, in English and Hindi. Lets zenvqo.voice press the right button in ANY
 * app, whatever language it's used in. Pure Kotlin, unit tested.
 */
object ActionWords {

    /** spoken word (Roman, lowercase) -> on-screen labels to look for. */
    private val SYN: Map<String, List<String>> = buildMap {
        fun put(labels: List<String>, vararg keys: String) = keys.forEach { put(it, labels) }

        put(listOf("like", "pasand"), "like", "pasand", "liked")
        put(listOf("unlike", "like"), "unlike", "dislike")
        put(listOf("comment", "add a comment", "comments"), "comment", "tippani", "tippani")
        put(listOf("share", "forward", "send"), "share", "forward", "bhejo", "saajha")
        put(listOf("send", "send message"), "send", "bhejna")
        put(listOf("follow", "following"), "follow", "following")
        put(listOf("unfollow", "following", "follow"), "unfollow")
        put(listOf("subscribe", "subscribed"), "subscribe", "subscribed")
        put(listOf("unsubscribe", "subscribed"), "unsubscribe")
        put(listOf("download", "save", "install"), "download", "downlod")
        put(listOf("save", "bookmark", "download"), "save", "bachao", "rakho", "sahej")
        put(listOf("delete", "remove", "trash", "move to trash"), "delete", "hatao", "mitao", "remove", "hata", "mita")
        put(listOf("edit"), "edit", "badlo", "sudharo")
        put(listOf("next", "skip", "skip ad", "continue"), "next", "agla", "aage", "skip")
        put(listOf("previous", "back", "prev"), "previous", "pichla", "pehle", "peeche")
        put(listOf("play"), "play")
        put(listOf("pause"), "pause", "roko", "ruko")
        put(listOf("cancel"), "cancel", "raddh")
        put(listOf("ok", "okay", "confirm", "done", "yes", "allow", "continue"), "ok", "okay", "theek", "confirm", "haan", "done")
        put(listOf("no", "cancel", "deny", "not now"), "no", "nahi", "mat")
        put(listOf("close", "dismiss", "x"), "close", "band", "hatao")
        put(listOf("add", "create", "new", "plus"), "add", "jodo", "naya", "banao")
        put(listOf("post", "share", "upload", "publish"), "post", "upload", "daalo", "dalo", "publish")
        put(listOf("retry", "try again", "reload"), "retry", "dobara", "phirse")
        put(listOf("refresh", "reload"), "refresh", "reload", "taaza")
        put(listOf("log in", "sign in", "login", "continue"), "login", "signin", "sign")
        put(listOf("log out", "sign out", "logout"), "logout", "signout")
        put(listOf("more options", "more", "menu", "options"), "menu", "options", "adhik", "zyada")
        put(listOf("settings", "setting"), "settings", "setting", "seting")
        put(listOf("profile", "account", "you"), "profile", "account", "khata")
        put(listOf("home"), "home", "ghar")
        put(listOf("search", "find"), "search", "dhundo", "dhoondo", "khojo", "find", "khoj")
        put(listOf("buy now", "buy", "add to cart", "order", "place order"), "buy", "kharido", "khareedo", "order")
        put(listOf("add to cart", "cart"), "cart", "basket")
        put(listOf("add to bag", "bag"), "bag")
        put(listOf("done", "ok", "save"), "done", "hogaya", "ho")
        put(listOf("start", "start now", "begin"), "start", "shuru", "chalu")
        put(listOf("stop", "end"), "stop", "band", "ruko")
        put(listOf("accept", "allow", "agree"), "accept", "manjur", "swikar", "agree")
        put(listOf("decline", "deny", "reject"), "decline", "reject", "inkaar", "mana")
        put(listOf("reply"), "reply", "jawab", "javab")
        put(listOf("mute"), "mute", "chup")
        put(listOf("unmute"), "unmute")
        put(listOf("add friend", "add"), "friend")
        put(listOf("repost", "retweet", "share"), "repost", "retweet")
        put(listOf("mark as read", "read"), "read", "padha")
        put(listOf("select all", "select"), "select")
        put(listOf("copy"), "copy", "copi")
        put(listOf("paste"), "paste")
        put(listOf("update"), "update", "apdet")
        put(listOf("install"), "install", "instal")
        put(listOf("uninstall"), "uninstall")
        put(listOf("open"), "open", "kholo", "khol")
    }

    /** Is this spoken word a known action verb? */
    fun isAction(word: String): Boolean = SYN.containsKey(word.trim().lowercase())

    /** All on-screen labels to try for a spoken phrase: the phrase, each word, and their synonyms. */
    fun expand(phrase: String): List<String> {
        val p = phrase.trim().lowercase()
        if (p.isEmpty()) return emptyList()
        val out = LinkedHashSet<String>()
        SYN[p]?.let { out.addAll(it) }
        out.add(p)
        for (w in p.split(" ").filter { it.isNotBlank() }) {
            SYN[w]?.let { out.addAll(it) }
            if (w.length >= 3) out.add(w)
        }
        return out.toList()
    }
}
