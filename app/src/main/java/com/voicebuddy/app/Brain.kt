package com.voicebuddy.app

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import com.minibrain.engine.Engine
import java.io.File
import java.util.concurrent.Executors

/**
 * Offline AI (MiniBrain): a small Transformer that runs fully on the phone, no internet.
 * The model file (model.bin, made with export_android.py) is picked once in Settings and
 * copied into the app. Answers questions the command parser doesn't understand.
 */
object Brain {
    private const val FILE = "brain.bin"
    private const val PREFS = "voicebuddy"
    private const val KEY_ON = "brain_answers"
    /** Follow-up questions within this time continue the same conversation. */
    private const val MEMORY_MS = 3 * 60 * 1000L
    private const val MAX_TURNS = 6

    private val worker = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private val history = mutableListOf<Engine.Message>()
    private var lastAsked = 0L

    @Volatile var engine: Engine? = null
        private set

    fun file(c: Context) = File(c.filesDir, FILE)
    fun hasModel(c: Context) = file(c).exists()
    fun isReady() = engine != null

    /** "Jo samajh na aaye uska jawab AI de" — on by default once a model is loaded. */
    fun answersUnknown(c: Context) =
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_ON, true)

    fun setAnswersUnknown(c: Context, on: Boolean) =
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_ON, on).apply()

    fun info(): String? = engine?.info()

    private fun threads() = Runtime.getRuntime().availableProcessors().coerceIn(1, 4)

    /** Loads the model in the background (call early so the first answer is quick). */
    fun warmUp(c: Context, done: ((error: String?) -> Unit)? = null) {
        val f = file(c.applicationContext)
        worker.execute {
            val err = try {
                if (engine == null && f.exists()) engine = Engine.load(f, threads())
                null
            } catch (t: Throwable) {
                t.message ?: t.toString()
            }
            if (done != null) main.post { done(err) }
        }
    }

    /** Copies a picked model.bin into the app, then loads it. */
    fun importModel(c: Context, uri: Uri, progress: (String) -> Unit, done: (error: String?) -> Unit) {
        val app = c.applicationContext
        engine?.cancel()
        worker.execute {
            val tmp = File(app.filesDir, "$FILE.tmp")
            val err = try {
                val size = app.contentResolver.query(uri, null, null, null, null)?.use { cur ->
                    val col = cur.getColumnIndex(OpenableColumns.SIZE)
                    if (cur.moveToFirst() && col >= 0 && !cur.isNull(col)) cur.getLong(col) else -1L
                } ?: -1L
                app.contentResolver.openInputStream(uri)!!.use { input ->
                    tmp.outputStream().use { out ->
                        val buf = ByteArray(1 shl 20)
                        var copied = 0L
                        var shown = 0L
                        while (true) {
                            val n = input.read(buf)
                            if (n <= 0) break
                            out.write(buf, 0, n)
                            copied += n
                            if (copied - shown > 8L shl 20) {
                                shown = copied
                                val msg = if (size > 0) "Model copy ho raha hai… ${copied * 100 / size}%"
                                          else "Model copy ho raha hai… ${copied shr 20} MB"
                                main.post { progress(msg) }
                            }
                        }
                    }
                }
                engine?.close()
                engine = null
                history.clear()
                val f = file(app)
                f.delete()
                if (!tmp.renameTo(f)) throw IllegalStateException("file save nahi hui")
                // load now: also checks that it really is a MiniBrain model
                try {
                    engine = Engine.load(f, threads())
                } catch (t: Throwable) {
                    f.delete()
                    throw t
                }
                null
            } catch (t: Throwable) {
                tmp.delete()
                t.message ?: t.toString()
            }
            main.post { done(err) }
        }
    }

    fun remove(c: Context) {
        engine?.cancel()
        worker.execute {
            engine?.close()
            engine = null
            history.clear()
            file(c.applicationContext).delete()
        }
    }

    fun cancel() { engine?.cancel() }

    /**
     * Answers [question] offline. [onPiece] gets the text as it is written, [onDone] the full answer
     * ("" if nothing came out). Both run on the main thread.
     */
    fun ask(c: Context, question: String, onPiece: (String) -> Unit, onDone: (String) -> Unit) {
        val app = c.applicationContext
        worker.execute {
            val reply = try {
                if (engine == null && file(app).exists()) engine = Engine.load(file(app), threads())
                val e = engine ?: throw IllegalStateException("no model")
                val now = System.currentTimeMillis()
                if (now - lastAsked > MEMORY_MS) { history.clear(); e.reset() }
                lastAsked = now
                history.add(Engine.Message("user", question))
                while (history.size > MAX_TURNS * 2) history.removeAt(0)
                val cfg = Engine.GenConfig().apply {
                    maxNewTokens = 160        // short, spoken answers
                    temperature = 0.6f
                }
                val out = e.chat(ArrayList(history), cfg) { piece -> main.post { onPiece(piece) } }
                if (out.isNotBlank()) history.add(Engine.Message("assistant", out)) else history.removeAt(history.size - 1)
                out
            } catch (t: Throwable) {
                ""
            }
            main.post { onDone(reply) }
        }
    }
}
