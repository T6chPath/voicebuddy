package com.voicebuddy.app

import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/** Finds the top video for a search on YouTube, so it can be opened and played directly. */
object YouTubeLookup {

    /** Returns the first real video's id (not an ad, Short or playlist), or null within [timeoutMs]. */
    fun firstVideoId(query: String, timeoutMs: Int = 4000): String? = try {
        val url = URL("https://www.youtube.com/results?hl=en&gl=IN&search_query=" +
            URLEncoder.encode(query, "UTF-8"))
        val c = (url.openConnection() as HttpURLConnection).apply {
            connectTimeout = timeoutMs
            readTimeout = timeoutMs
            setRequestProperty("User-Agent",
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36")
            setRequestProperty("Accept-Language", "en-IN,en;q=0.9")
            setRequestProperty("Cookie", "CONSENT=YES+1; SOCS=CAI")
        }
        val html = c.inputStream.bufferedReader().use { it.readText() }
        c.disconnect()
        pickVideoId(html)
    } catch (e: Exception) {
        null
    }

    /** Pure parsing, unit tested: the first "videoRenderer" in the page is the first normal result. */
    fun pickVideoId(html: String): String? =
        Regex("\"videoRenderer\":\\{\"videoId\":\"([A-Za-z0-9_-]{11})\"").find(html)?.groupValues?.get(1)
}
