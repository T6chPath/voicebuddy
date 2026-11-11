package app.zenvqo.chat;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * "Share → zenvqo" from WhatsApp, Gallery, Files or any app (like ChatGPT): photos, videos, documents, voice notes and
 * text. The shared files are copied into the app right away (the sending app's permission only lasts a short while),
 * then the page picks them up. Exposed as window.ZenvqoShare:
 *   pending()             → {"busy":true} while copying, else {"text": "...", "files": [{id, name, mime, size}]}
 *   read(id, offset, len) → base64 of that part of a file (the page reads big files in pieces)
 *   done()                → forget (and delete) what was shared
 * When something new arrives, the page is told with window.__zshare().
 */
final class NativeShare {
    private static final String TAG = "ZenvqoShare";
    private static final long MAX_BYTES = 500L * 1024 * 1024;
    private static final int MAX_FILES = 10;
    private final Activity activity;
    private final WebView web;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final List<JSONObject> files = new ArrayList<>();
    private final List<File> paths = new ArrayList<>();
    private String text = "";
    private volatile boolean busy = false;
    private int seq = 0;

    NativeShare(Activity activity, WebView web) {
        this.activity = activity;
        this.web = web;
    }

    /** Called with the intent that opened (or came back to) the app. */
    void take(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return;
        final Set<Uri> uris = new LinkedHashSet<>();
        try {
            if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
                ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
                if (list != null) uris.addAll(list);
            } else {
                Uri one = intent.getParcelableExtra(Intent.EXTRA_STREAM);
                if (one != null) uris.add(one);
            }
        } catch (Exception e) { Log.w(TAG, "no stream", e); }
        ClipData clip = intent.getClipData();
        if (clip != null) for (int i = 0; i < clip.getItemCount(); i++) { Uri u = clip.getItemAt(i).getUri(); if (u != null) uris.add(u); }
        CharSequence t = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        CharSequence subject = intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT);
        final String shared = ((subject != null && t != null && !t.toString().contains(subject) ? subject + "\n" : "") + (t != null ? t : "")).trim();
        final String type = intent.getType();
        intent.setAction(Intent.ACTION_MAIN);                       // handled: don't take it again (e.g. after rotation)
        if (uris.isEmpty() && shared.isEmpty()) return;
        busy = true;
        worker.execute(() -> {
            synchronized (this) { clear(); text = shared; }
            File dir = new File(activity.getCacheDir(), "shared");
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
            ContentResolver r = activity.getContentResolver();
            for (Uri u : uris) {
                if (files.size() >= MAX_FILES) break;
                String scheme = u.getScheme() == null ? "" : u.getScheme();
                if (!scheme.equals("content")) continue;            // file:// and others are not accepted from other apps
                try {
                    String name = displayName(r, u);
                    String mime = r.getType(u);
                    if (mime == null || mime.isEmpty()) mime = type != null && !type.contains("*") ? type : "application/octet-stream";
                    if (name == null || name.trim().isEmpty()) name = "shared-" + (files.size() + 1) + extFor(mime);
                    name = name.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1f]", "_");
                    File out = new File(dir, (++seq) + "-" + name);
                    long size = 0;
                    try (InputStream in = r.openInputStream(u); OutputStream os = new FileOutputStream(out)) {
                        if (in == null) continue;
                        byte[] buf = new byte[65536];
                        int n;
                        while ((n = in.read(buf)) > 0) {
                            size += n;
                            if (size > MAX_BYTES) throw new IllegalStateException("too big");
                            os.write(buf, 0, n);
                        }
                    }
                    synchronized (this) {
                        files.add(new JSONObject().put("id", String.valueOf(seq)).put("name", name).put("mime", mime).put("size", size));
                        paths.add(out);
                    }
                } catch (Throwable e) {
                    Log.w(TAG, "couldn't copy " + u, e);
                }
            }
            busy = false;
            Log.i(TAG, "shared: " + files.size() + " file(s), text " + text.length() + " chars");
            web.post(() -> web.evaluateJavascript("window.__zshare&&window.__zshare()", null));
        });
    }

    @JavascriptInterface
    public synchronized String pending() {
        try {
            if (busy) return "{\"busy\":true}";
            return new JSONObject().put("text", text).put("files", new JSONArray(files)).toString();
        } catch (Exception e) { return "{\"files\":[],\"text\":\"\"}"; }
    }

    @JavascriptInterface
    public String read(String id, double offset, int length) {
        File f;
        synchronized (this) {
            int i = -1;
            for (int k = 0; k < files.size(); k++) if (id.equals(files.get(k).optString("id"))) i = k;
            if (i < 0) return "";
            f = paths.get(i);
        }
        try (RandomAccessFile raf = new RandomAccessFile(f, "r")) {
            long off = (long) offset;
            int n = (int) Math.max(0, Math.min(length, raf.length() - off));
            byte[] b = new byte[n];
            raf.seek(off);
            raf.readFully(b);
            return Base64.encodeToString(b, Base64.NO_WRAP);
        } catch (Exception e) {
            return "";
        }
    }

    @JavascriptInterface
    public synchronized void done() { clear(); }

    private void clear() {
        for (File f : paths) //noinspection ResultOfMethodCallIgnored
            f.delete();
        paths.clear();
        files.clear();
        text = "";
    }

    private static String displayName(ContentResolver r, Uri u) {
        try (Cursor c = r.query(u, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (i >= 0) return c.getString(i);
            }
        } catch (Exception ignored) { /* some apps don't answer */ }
        String last = u.getLastPathSegment();
        return last != null && last.contains(".") ? last.substring(last.lastIndexOf('/') + 1) : null;
    }

    private static String extFor(String mime) {
        if (mime.startsWith("image/jpeg")) return ".jpg";
        if (mime.startsWith("image/")) return "." + mime.substring(6).replace("+xml", "");
        if (mime.startsWith("video/")) return "." + mime.substring(6);
        if (mime.equals("audio/ogg") || mime.contains("opus")) return ".ogg";   // WhatsApp voice notes
        if (mime.startsWith("audio/")) return "." + mime.substring(6);
        if (mime.equals("application/pdf")) return ".pdf";
        if (mime.startsWith("text/")) return ".txt";
        return "";
    }
}
