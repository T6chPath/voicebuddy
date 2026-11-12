package app.zenvqo.chat;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * "Google Play package" (window.ZenvqoPlay): a web page → a folder with everything Google Play Console needs —
 * the signed App Bundle (.aab, made by PlayBundle), the store icon, feature graphic and phone screenshots, the texts the
 * page passes in (listing, privacy policy, data safety, step-by-step guide) and the upload key — as one .zip in
 * Downloads/zenvqo. Each app keeps its own upload key here, so later versions are signed with the same key.
 * Results go to window.__zplay(id, event, data): "step" (what it's doing), "done" (JSON) or "error" (message).
 */
public final class NativePlay {
    private static final String TAG = "ZenvqoPlay";
    private static final int SHOT_W = 1080, SHOT_H = 1920;
    private final Activity activity;
    private final WebView web;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Map<String, Uri> saved = new HashMap<>();
    private final Map<String, String> names = new HashMap<>();

    NativePlay(Activity activity, WebView web) {
        this.activity = activity;
        this.web = web;
    }

    @JavascriptInterface
    public String status() {
        try (InputStream in = activity.getAssets().open("webshell.aab")) {
            return "{\"ready\":true,\"downloads\":" + (Build.VERSION.SDK_INT >= 29) + "}";
        } catch (Exception e) {
            return "{\"ready\":false,\"reason\":\"The Google Play template is missing from this build.\"}";
        }
    }

    /** Has this app (package) got an upload key already? Then the package is an update of an earlier one. */
    @JavascriptInterface
    public boolean hasKey(String pkg) {
        return ApkMaker.validPackage(pkg) && keyFile(pkg).exists();
    }

    @JavascriptInterface
    public void make(final String id, final String json) {
        worker.execute(() -> {
            try {
                JSONObject a = new JSONObject(json);
                String html = a.getString("html");
                String label = a.optString("name", "").trim();
                if (label.isEmpty()) label = "My app";
                if (label.length() > 30) label = label.substring(0, 30);
                String pkg = a.getString("pkg").trim();
                if (!ApkMaker.validPackage(pkg)) throw new IllegalArgumentException("“" + pkg + "” isn't a valid package name.");
                int vc = a.getInt("versionCode");
                String vn = a.optString("versionName", "1.0");
                String iconB64 = a.optString("icon", "");
                String folder = a.optString("folder", "").replaceAll("[^A-Za-z0-9 _-]", "").trim().replace(' ', '-');
                if (folder.isEmpty()) folder = "app";
                folder += "-Google-Play";

                step(id, "Making the app bundle…");
                byte[] picture = iconB64.isEmpty() ? null : Base64.decode(iconB64, Base64.DEFAULT);
                byte[] icon = picture != null ? NativeApk.iconFromImage(picture, 192) : null;
                if (icon == null) icon = NativeApk.letterIcon(label, 192, true);
                byte[] storeIcon = picture != null ? NativeApk.iconFromImage(picture, 512) : null;
                if (storeIcon == null) storeIcon = NativeApk.letterIcon(label, 512, false);

                char[] pw = password(pkg);
                File kf = keyFile(pkg);
                boolean newKey = !kf.exists();
                if (newKey) {
                    //noinspection ResultOfMethodCallIgnored
                    kf.getParentFile().mkdirs();
                    try (OutputStream o = new FileOutputStream(kf)) { o.write(PlayBundle.newUploadKeystore(label, pw)); }
                }
                byte[] p12;
                try (InputStream in = new java.io.FileInputStream(kf)) { p12 = NativeApk.readAll(in); }
                KeyStore ks = PlayBundle.loadKeystore(p12, pw);
                PrivateKey key = (PrivateKey) ks.getKey("upload", pw);
                X509Certificate cert = (X509Certificate) ks.getCertificate("upload");

                byte[] template;
                try (InputStream in = activity.getAssets().open("webshell.aab")) { template = NativeApk.readAll(in); }
                byte[] aab = PlayBundle.make(template, html.getBytes(StandardCharsets.UTF_8), label, pkg, icon, vc, vn, key, cert);

                step(id, "Taking screenshots…");
                List<byte[]> shots = screenshots(html);

                step(id, "Packing the folder…");
                byte[] feature = featureGraphic(label, storeIcon, picture != null);
                ByteArrayOutputStream zb = new ByteArrayOutputStream();
                String base = folder + "/";
                String file = folder.replace("-Google-Play", "");
                try (ZipOutputStream z = new ZipOutputStream(zb)) {
                    put(z, base + file + ".aab", aab);
                    put(z, base + "store-listing/app-icon-512.png", storeIcon);
                    put(z, base + "store-listing/feature-graphic-1024x500.jpg", feature);
                    for (int i = 0; i < shots.size(); i++) put(z, base + "store-listing/phone-screenshot-" + (i + 1) + ".jpg", shots.get(i));
                    JSONObject texts = a.optJSONObject("files");
                    if (texts != null) {
                        for (Iterator<String> it = texts.keys(); it.hasNext(); ) {
                            String name = it.next();
                            if (name.contains("..") || name.startsWith("/")) continue;
                            put(z, base + name, texts.getString(name).getBytes(StandardCharsets.UTF_8));
                        }
                    }
                    String sha256 = PlayBundle.fingerprint(cert, "SHA-256"), sha1 = PlayBundle.fingerprint(cert, "SHA-1");
                    put(z, base + "upload-key-KEEP-PRIVATE/upload-key.p12", p12);
                    put(z, base + "upload-key-KEEP-PRIVATE/upload_certificate.pem", PlayBundle.pem(cert).getBytes(StandardCharsets.US_ASCII));
                    put(z, base + "upload-key-KEEP-PRIVATE/README.txt", ("UPLOAD KEY for " + label + " (" + pkg + ")\n\n"
                            + "Keep this folder private. Never upload it to Google Play or share it. Only the .aab file goes to Play Console.\n"
                            + "zenvqo keeps this key on your phone and signs every new version of this app with it.\n"
                            + "Keep a copy somewhere safe (for example your Google Drive): if you lose it, you can ask Google Play\n"
                            + "for an upload key reset (Play Console → Test and release → App integrity → App signing), using upload_certificate.pem.\n\n"
                            + "Keystore file:   upload-key.p12 (PKCS#12)\n"
                            + "Key alias:       upload\n"
                            + "Password:        " + new String(pw) + "  (the same for the keystore and the key)\n\n"
                            + "Certificate fingerprints (Play Console shows them under App integrity):\n"
                            + "SHA-256: " + sha256 + "\nSHA-1:   " + sha1 + "\n").getBytes(StandardCharsets.UTF_8));
                }
                byte[] zip = zb.toByteArray();
                String where = "";
                if (Build.VERSION.SDK_INT >= 29) {
                    saved.put(id, toDownloads(zip, folder + ".zip"));
                    where = "Downloads/zenvqo/" + folder + ".zip";
                } else {
                    File out = new File(activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), folder + ".zip");
                    try (OutputStream o = new FileOutputStream(out)) { o.write(zip); }
                    where = out.getAbsolutePath();
                }
                names.put(id, label);
                JSONObject r = new JSONObject().put("saved", where).put("size", zip.length).put("aab", aab.length).put("aabName", file + ".aab")
                        .put("folder", folder).put("pkg", pkg).put("versionCode", vc).put("versionName", vn).put("shots", shots.size())
                        .put("newKey", newKey).put("sha256", PlayBundle.fingerprint(cert, "SHA-256"));
                send(id, "done", r.toString());
            } catch (Throwable t) {
                Log.e(TAG, "make failed", t);
                send(id, "error", t instanceof IllegalArgumentException ? t.getMessage()
                        : "Couldn't make the Google Play package (" + t.getClass().getSimpleName() + (t.getMessage() != null ? ": " + t.getMessage() : "") + ").");
            }
        });
    }

    @JavascriptInterface
    public void share(String id) {
        final Uri uri = saved.get(id);
        final String label = names.get(id);
        activity.runOnUiThread(() -> {
            if (uri == null) { Toast.makeText(activity, "Sharing needs Android 10 or newer.", Toast.LENGTH_SHORT).show(); return; }
            Intent i = new Intent(Intent.ACTION_SEND).setType("application/zip").putExtra(Intent.EXTRA_STREAM, uri)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            activity.startActivity(Intent.createChooser(i, "Share " + (label == null ? "Google Play package" : label + " for Google Play")));
        });
    }

    /* ---------------- screenshots ---------------- */

    /** Phone screenshots of the page (1080×1920, what Play asks for): the top, and further down if the page is long.
     *  The page runs in a WebView behind the chat, so nothing shows on screen. */
    private List<byte[]> screenshots(String html) {
        final List<byte[]> shots = new ArrayList<>();
        final Object lock = new Object();
        final AtomicBoolean finished = new AtomicBoolean(false);
        final Handler h = new Handler(Looper.getMainLooper());
        final WebView[] holder = new WebView[1];
        final Runnable finish = () -> {
            if (!finished.compareAndSet(false, true)) return;
            WebView w = holder[0];
            if (w != null) {
                ViewGroup p = (ViewGroup) w.getParent();
                if (p != null) p.removeView(w);
                w.destroy();
            }
            synchronized (lock) { lock.notifyAll(); }
        };
        h.post(() -> {
            try {
                ViewGroup root = activity.findViewById(android.R.id.content);
                WebView w = new WebView(activity);
                holder[0] = w;
                w.getSettings().setJavaScriptEnabled(true);
                w.getSettings().setDomStorageEnabled(true);
                w.setVerticalScrollBarEnabled(false);
                w.setBackgroundColor(Color.WHITE);
                root.addView(w, 0, new FrameLayout.LayoutParams(SHOT_W, SHOT_H));    // behind the chat
                final Runnable second = () -> {
                    if (finished.get()) return;
                    byte[] b = snap(w);
                    if (b != null) shots.add(b);
                    finish.run();
                };
                final Runnable first = () -> {
                    if (finished.get()) return;
                    byte[] b = snap(w);
                    if (b != null) shots.add(b);
                    w.evaluateJavascript("(function(){var d=document.documentElement,b=document.body,h=Math.max(d.scrollHeight,b?b.scrollHeight:0),v=innerHeight;"
                            + "if(h>v*1.35){scrollTo(0,Math.min(h-v,Math.round(v*0.9)));return 1}return 0})()",
                            r -> { if ("1".equals(r)) h.postDelayed(second, 900); else finish.run(); });
                };
                w.setWebViewClient(new WebViewClient() {
                    boolean once;
                    @Override public void onPageFinished(WebView view, String url) {
                        if (once) return;
                        once = true;
                        h.postDelayed(first, 1800);                      // fonts, pictures and scripts settle
                    }
                    @Override public boolean shouldOverrideUrlLoading(WebView view, android.webkit.WebResourceRequest req) { return true; }
                });
                w.loadDataWithBaseURL("file:///android_asset/", html, "text/html", "utf-8", null);
            } catch (Throwable t) {
                Log.w(TAG, "screenshots failed", t);
                finish.run();
            }
        });
        h.postDelayed(finish, 25_000);
        synchronized (lock) {
            long until = System.currentTimeMillis() + 27_000;
            while (!finished.get() && System.currentTimeMillis() < until) {
                try { lock.wait(1000); } catch (InterruptedException e) { break; }
            }
        }
        return shots;
    }

    /** The WebView drawn into a picture; null if it came out blank. */
    private static byte[] snap(WebView w) {
        try {
            Bitmap b = Bitmap.createBitmap(SHOT_W, SHOT_H, Bitmap.Config.ARGB_8888);
            Canvas c = new Canvas(b);
            c.drawColor(Color.WHITE);
            w.draw(c);
            int first = b.getPixel(SHOT_W / 2, SHOT_H / 2), same = 0, n = 0;
            for (int y = 40; y < SHOT_H; y += 97) for (int x = 20; x < SHOT_W; x += 61) { n++; if (b.getPixel(x, y) == first) same++; }
            if (same == n) { Log.w(TAG, "screenshot came out blank"); return null; }
            ByteArrayOutputStream o = new ByteArrayOutputStream();
            b.compress(Bitmap.CompressFormat.JPEG, 92, o);
            return o.toByteArray();
        } catch (Throwable t) {
            Log.w(TAG, "snap failed", t);
            return null;
        }
    }

    /* ---------------- store pictures ---------------- */

    /** 1024×500 banner (Play's "feature graphic", JPEG — no transparency allowed): the icon and the app's name on its colour. */
    private static byte[] featureGraphic(String label, byte[] iconPng, boolean picture) {
        Bitmap icon = BitmapFactory.decodeByteArray(iconPng, 0, iconPng.length);
        int colour = picture && icon != null ? average(icon) : NativeApk.letterColour(label);
        Bitmap b = Bitmap.createBitmap(1024, 500, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(b);
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
        p.setShader(new LinearGradient(0, 0, 1024, 500, lighter(colour), darker(colour), Shader.TileMode.CLAMP));
        c.drawRect(0, 0, 1024, 500, p);
        p.setShader(null);
        if (icon != null) {
            RectF r = new RectF(96, 140, 316, 360);
            p.setColor(0x33000000);
            c.drawRoundRect(new RectF(r.left + 4, r.top + 10, r.right + 4, r.bottom + 10), 52, 52, p);
            Bitmap rounded = Bitmap.createBitmap(220, 220, Bitmap.Config.ARGB_8888);
            Canvas rc = new Canvas(rounded);
            Paint m = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
            rc.drawRoundRect(new RectF(0, 0, 220, 220), 50, 50, m);
            m.setXfermode(new android.graphics.PorterDuffXfermode(android.graphics.PorterDuff.Mode.SRC_IN));
            rc.drawBitmap(icon, null, new RectF(0, 0, 220, 220), m);
            c.drawBitmap(rounded, null, r, p);
        }
        p.setColor(Color.WHITE);
        p.setTypeface(Typeface.create(Typeface.DEFAULT, Typeface.BOLD));
        float size = 84;
        p.setTextSize(size);
        while (p.measureText(label) > 600 && size > 36) p.setTextSize(size -= 4);
        Paint.FontMetrics fm = p.getFontMetrics();
        c.drawText(label, 370, 250 - (fm.ascent + fm.descent) / 2, p);
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        b.compress(Bitmap.CompressFormat.JPEG, 92, o);
        return o.toByteArray();
    }

    private static int average(Bitmap b) {
        long r = 0, g = 0, bl = 0, n = 0;
        for (int y = 0; y < b.getHeight(); y += 8) for (int x = 0; x < b.getWidth(); x += 8) {
            int c = b.getPixel(x, y);
            if (Color.alpha(c) < 128) continue;
            r += Color.red(c); g += Color.green(c); bl += Color.blue(c); n++;
        }
        if (n == 0) return 0xFF0060E6;
        return Color.rgb((int) (r / n), (int) (g / n), (int) (bl / n));
    }
    private static int darker(int c) { return Color.rgb(Color.red(c) * 55 / 100, Color.green(c) * 55 / 100, Color.blue(c) * 55 / 100); }
    private static int lighter(int c) { return Color.rgb(Math.min(255, Color.red(c) * 85 / 100 + 20), Math.min(255, Color.green(c) * 85 / 100 + 20), Math.min(255, Color.blue(c) * 85 / 100 + 20)); }

    /* ---------------- helpers ---------------- */

    private File keyFile(String pkg) { return new File(new File(activity.getFilesDir(), "play-keys"), pkg + ".p12"); }

    /** Each app's keystore password, made once and kept next to its key (in the app's private storage). */
    private char[] password(String pkg) throws Exception {
        File f = new File(new File(activity.getFilesDir(), "play-keys"), pkg + ".pw");
        if (f.exists()) try (InputStream in = new java.io.FileInputStream(f)) { return new String(NativeApk.readAll(in), StandardCharsets.UTF_8).trim().toCharArray(); }
        final String abc = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
        SecureRandom r = new SecureRandom();
        StringBuilder s = new StringBuilder();
        for (int i = 0; i < 20; i++) s.append(abc.charAt(r.nextInt(abc.length())));
        //noinspection ResultOfMethodCallIgnored
        f.getParentFile().mkdirs();
        try (OutputStream o = new FileOutputStream(f)) { o.write(s.toString().getBytes(StandardCharsets.UTF_8)); }
        return s.toString().toCharArray();
    }

    private static void put(ZipOutputStream z, String name, byte[] data) throws Exception {
        z.putNextEntry(new ZipEntry(name));
        z.write(data);
        z.closeEntry();
    }

    private Uri toDownloads(byte[] data, String name) throws Exception {
        ContentResolver r = activity.getContentResolver();
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        v.put(MediaStore.MediaColumns.MIME_TYPE, "application/zip");
        v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/zenvqo");
        v.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri uri = r.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
        if (uri == null) throw new IllegalStateException("Couldn't save to Downloads.");
        try (OutputStream out = r.openOutputStream(uri)) {
            if (out == null) throw new IllegalStateException("Couldn't save to Downloads.");
            out.write(data);
        }
        v.clear();
        v.put(MediaStore.MediaColumns.IS_PENDING, 0);
        r.update(uri, v, null, null);
        return uri;
    }

    private void step(String id, String what) { send(id, "step", what); }

    private void send(String id, String event, String data) {
        final String js = "window.__zplay&&window.__zplay(" + JSONObject.quote(id) + "," + JSONObject.quote(event) + "," + JSONObject.quote(data) + ")";
        activity.runOnUiThread(() -> web.evaluateJavascript(js, null));
    }
}
