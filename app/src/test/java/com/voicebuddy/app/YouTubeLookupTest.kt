package com.voicebuddy.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class YouTubeLookupTest {
    @Test fun skipsAdsAndPicksFirstVideo() {
        val html = """{"adSlotRenderer":{"videoId":"AAAAAAAAAAA"}},{"reelShelfRenderer":{"videoId":"BBBBBBBBBBB"}},""" +
            """{"videoRenderer":{"videoId":"JFcgOboQZ08","thumbnail":{}}},{"videoRenderer":{"videoId":"zzzzzzzzzzz"}}"""
        assertEquals("JFcgOboQZ08", YouTubeLookup.pickVideoId(html))
    }

    @Test fun nothingFound() = assertNull(YouTubeLookup.pickVideoId("<html>no results</html>"))
}
