package com.voicebuddy.app

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.text.Html
import android.view.View
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity

/** Privacy policy, Terms & conditions, Contact us and About pages. */
class InfoActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_PAGE = "page"
        const val PRIVACY = "privacy"
        const val TERMS = "terms"
        const val CONTACT = "contact"
        const val ABOUT = "about"
        const val CONTACT_EMAIL = "zenvqo.voice@gmail.com"
        private const val UPDATED = "1 November 2026"

        fun open(c: Context, page: String) =
            c.startActivity(Intent(c, InfoActivity::class.java).putExtra(EXTRA_PAGE, page))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_info)
        findViewById<View>(R.id.backButton).setOnClickListener { finish() }

        val page = intent.getStringExtra(EXTRA_PAGE) ?: ABOUT
        val (title, body) = when (page) {
            PRIVACY -> "Privacy Policy" to privacy()
            TERMS -> "Terms & Conditions" to terms()
            CONTACT -> "Contact Us" to contact()
            else -> "About" to about()
        }
        findViewById<TextView>(R.id.infoTitle).text = title
        findViewById<TextView>(R.id.infoBody).text = Html.fromHtml(body, Html.FROM_HTML_MODE_COMPACT)

        if (page == CONTACT) setupContact()
    }

    private fun setupContact() {
        findViewById<View>(R.id.contactCard).visibility = View.VISIBLE
        findViewById<TextView>(R.id.contactEmail).text = CONTACT_EMAIL
        findViewById<View>(R.id.emailButton).setOnClickListener {
            val version = versionName()
            val intent = Intent(Intent.ACTION_SENDTO, Uri.parse("mailto:$CONTACT_EMAIL"))
                .putExtra(Intent.EXTRA_EMAIL, arrayOf(CONTACT_EMAIL))
                .putExtra(Intent.EXTRA_SUBJECT, "zenvqo.voice feedback (v$version)")
            try {
                startActivity(intent)
            } catch (e: ActivityNotFoundException) {
                Toast.makeText(this, "Email app nahi mila. Address copy karke bhejiye.", Toast.LENGTH_LONG).show()
            }
        }
        findViewById<View>(R.id.copyButton).setOnClickListener {
            val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            cm.setPrimaryClip(ClipData.newPlainText("email", CONTACT_EMAIL))
            Toast.makeText(this, "Email copy ho gaya", Toast.LENGTH_SHORT).show()
        }
    }

    private fun versionName(): String =
        try { packageManager.getPackageInfo(packageName, 0).versionName ?: "" } catch (e: Exception) { "" }

    private fun contact() = """
        Koi sawaal, problem ya naya idea? Hamein email kijiye — hum jawab denge.<br><br>
        <b>Email karte waqt ye bata dein to madad jaldi hogi:</b><br>
        • Aapne kya bola tha (app mein quotes mein jo dikha)<br>
        • Kya hona chahiye tha aur kya hua<br>
        • Phone ka model aur Android version
    """.trimIndent()

    private fun about() = """
        <b>zenvqo.voice</b> — version ${versionName()}<br><br>
        Hinglish, Hindi aur English mein bolo, aur phone kaam kar dega: call (SIM 1 / SIM 2), WhatsApp message,
        audio aur video call, YouTube par gaana, Gmail, ChatGPT / Claude / Gemini / Google par sawaal,
        torch, Wi-Fi, Bluetooth, volume, screenshot, silent/DND, battery saver, auto brightness, reading mode, screen record,
        aur kisi bhi app ke andar tap, type aur scroll.<br><br>
        Kisi bhi app mein bolke button dabwa sakte ho — “like karo”, “share karo”, “download karo”,
        “follow karo”, “next”, “ok”, ya kisi bhi button ka naam. English, Hindi ya Hinglish, teeno chalte hain.<br><br>
        Galat spelling ho to bhi samajh jaata hai — “chart gpt”, “watsapp”, “pradhaman”.<br><br>
        <b>WhatsApp mein bolke</b> (sab apne aap hota hai)<br>
        • “Papa ko voice message bhejo” / “20 second ka voice message”<br>
        • “Papa ke message ka reply karo ki haan” · “heart react karo”<br>
        • “Papa ka last message edit karo ki …” · “sabke liye delete karo”<br>
        • “Papa ka last message rahul ko forward karo”<br>
        • “Rahul ko happy birthday ka gif / sticker bhejo”<br>
        • “Papa ko location / resume pdf / rahul ka contact bhejo”<br>
        • “Family group ko poll bhejo kahan chalein options goa aur manali”<br>
        • “Status lagao ki …” · “photo status lagao kesariya gaane ke saath”<br>
        • “Virat kohli channel follow karo” · “rahul ko block karo”<br>
        • “WhatsApp dark mode on karo” · “whatsapp ki language hindi karo”<br><br>
        <b>Jaldi bolne ke tareeke</b><br>
        • Orange “Bolo” icon: seedha sunna shuru<br>
        • Quick Settings mein zenvqo.voice tile<br>
        • App kholte hi ek aur tap, ya kahin bhi double-tap<br>
        • Phone ka assistant gesture (Home / Power button daba ke rakho)<br><br>
        Contact: $CONTACT_EMAIL
    """.trimIndent()

    private fun privacy() = """
        <i>Last updated: $UPDATED</i><br><br>
        zenvqo.voice aapki privacy ka dhyan rakhta hai. Ye page batata hai ki app kya data use karta hai aur kyun.<br><br>
        <b>1. Hum kya collect karte hain</b><br>
        zenvqo.voice ka koi server nahi hai. Hum aapka koi bhi data apne paas nahi bhejte, store nahi karte, aur kisi ko nahi bechte.<br><br>
        <b>2. Aapki awaaz</b><br>
        Jab aap mic dabate hain, aapki awaaz phone ki speech recognition service (aam taur par Google) ko text banane ke liye jaati hai.
        Ye Google ki apni privacy policy ke hisaab se hota hai. App sirf bana hua text use karta hai, recording save nahi karta.<br><br>
        <b>3. Contacts</b><br>
        Naam se call, message ya email karne ke liye app phone ke andar hi contacts padhta hai. Contacts phone se bahar nahi jaate.<br><br>
        <b>4. Phone</b><br>
        Call karne aur SIM 1 / SIM 2 chunne ke liye Phone permission use hoti hai. App aapki call history nahi padhta.<br><br>
        <b>5. Apne aap kaam karna (Accessibility permission)</b><br>
        zenvqo.voice ye permission sirf aapke bole hue command ke turant baad use karta hai — jaise Send dabana, video chalana ya switch badalna.
        Ye screen ka content save ya kahin nahi bhejta, aur apne aap kuch nahi karta.<br><br>
        <b>6. Phone par save hone wali cheezein</b><br>
        Pichle commands aur aapki bhasha ki setting sirf aapke phone par save hoti hain. Sidebar mein “Clear” se commands mita sakte hain;
        app uninstall karne par sab hat jaata hai.<br><br>
        <b>7. Doosre apps</b><br>
        Jab app WhatsApp, YouTube, Gmail, ChatGPT, Google jaise apps kholta hai, wahan ki privacy un apps ki apni policy ke hisaab se hoti hai.<br><br>
        <b>8. Bachche</b><br>
        Ye app 13 saal se kam umar ke bachchon ke liye nahi bana hai.<br><br>
        <b>9. Badlav</b><br>
        Is policy mein badlav hone par is page ki date update ki jayegi.<br><br>
        <b>10. Contact</b><br>
        Sawaal ho to email kijiye: $CONTACT_EMAIL
    """.trimIndent()

    private fun terms() = """
        <i>Last updated: $UPDATED</i><br><br>
        zenvqo.voice use karke aap in terms se sehmat hote hain.<br><br>
        <b>1. App ka use</b><br>
        App aapke bole hue commands par phone ke kaam karta hai. Aap ise sirf apne phone par aur kanoon ke andar use karenge.<br><br>
        <b>2. Aapki zimmedari</b><br>
        Calls, messages aur emails aapke naam se jaate hain. Bhejne se pehle dekh lein ki app ne sahi naam aur sahi baat samjhi hai.
        Galat samjhe gaye command se hua koi bhi message, call ya kharcha (jaise call charges) aapki zimmedari hai.<br><br>
        <b>3. Bina guarantee ke</b><br>
        App jaisa hai waisa diya gaya hai. Hum koshish karte hain ki sab sahi chale, par har phone aur har app par har command kaam karega,
        iski guarantee nahi hai. Doosre apps ke update ke baad kuch features badal sakte hain.<br><br>
        <b>4. Doosre apps aur brands</b><br>
        WhatsApp, YouTube, Gmail, Google, Chrome, ChatGPT, Claude, Gemini aur baaki naam unke maalikon ke trademark hain.
        zenvqo.voice inse juda hua ya inke dwara banaya hua nahi hai.<br><br>
        <b>5. Zimmedari ki seema</b><br>
        Kanoon jitni ijazat deta hai, us had tak app ke use se hone wale kisi nuksaan ke liye hum zimmedar nahi honge.<br><br>
        <b>6. Badlav</b><br>
        In terms mein badlav ho sakta hai; nayi date is page par dikhegi. Badlav ke baad app use karte rehna un terms ko maanna hai.<br><br>
        <b>7. Contact</b><br>
        $CONTACT_EMAIL
    """.trimIndent()
}
