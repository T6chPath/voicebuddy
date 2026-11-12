package app.zenvqo.chat;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.cert.X509Certificate;
import java.util.Calendar;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.security.auth.x500.X500Principal;

/**
 * "Make app": turns a web page into an installable APK on the phone. Exposed as window.ZenvqoApk.
 *   build(id, html, name, iconBase64)  → __zapk(id, "built", {pkg, name, size, saved})  |  __zapk(id, "error", message)
 *   install(id)                        → the system's install screen; __zapk(id, "installed" | "install-failed", detail)
 *   open(id), share(id)
 * Apps are signed with one key that never leaves the phone's keystore, so a rebuilt app installs as an update.
 */
final class NativeApk {
    private static final String TAG = "ZenvqoApk";
    private static final String KEY_ALIAS = "zenvqo-web-apps";
    private static final String ACTION = "app.zenvqo.chat.APK_INSTALL_STATUS";
    private final Activity activity;
    private final WebView web;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Map<String, File> built = new HashMap<>();
    private final Map<String, String> pkgs = new HashMap<>();
    private final Map<String, Uri> saved = new HashMap<>();
    private final Map<String, String> names = new HashMap<>();
    private boolean listening;

    NativeApk(Activity activity, WebView web) {
        this.activity = activity;
        this.web = web;
    }

    @JavascriptInterface
    public String status() {
        try (InputStream in = activity.getAssets().open("webshell.apk")) {
            return "{\"ready\":true}";
        } catch (Exception e) {
            return "{\"ready\":false,\"reason\":\"The app template is missing from this build.\"}";
        }
    }

    @JavascriptInterface
    public void build(final String id, final String html, final String name, final String iconB64) {
        worker.execute(() -> {
            try {
                String label = name == null || name.trim().isEmpty() ? "My app" : name.trim();
                if (label.length() > 50) label = label.substring(0, 50);
                byte[] template;
                try (InputStream in = activity.getAssets().open("webshell.apk")) { template = readAll(in); }
                String salt = Long.toString(Math.abs((label + html.length()).hashCode()) % 46656, 36);
                String pkg = ApkMaker.packageFor(label, salt);
                byte[] icon = iconB64 != null && !iconB64.isEmpty() ? iconFromImage(Base64.decode(iconB64, Base64.DEFAULT)) : letterIcon(label);
                KeyStore ks = signingKey();
                PrivateKey key = (PrivateKey) ks.getKey(KEY_ALIAS, null);
                X509Certificate cert = (X509Certificate) ks.getCertificate(KEY_ALIAS);
                byte[] apk = ApkMaker.make(template, html.getBytes(StandardCharsets.UTF_8), label, pkg, icon, key, cert);
                File dir = new File(activity.getCacheDir(), "apps");
                //noinspection ResultOfMethodCallIgnored
                dir.mkdirs();
                String file = label.replaceAll("[^A-Za-z0-9 _-]", "").trim().replace(' ', '-');
                if (file.isEmpty()) file = "app";
                File f = new File(dir, file + ".apk");
                try (OutputStream out = new FileOutputStream(f)) { out.write(apk); }
                built.put(id, f);
                pkgs.put(id, pkg);
                names.put(id, label);
                String where = "";
                if (Build.VERSION.SDK_INT >= 29) {
                    try { saved.put(id, toDownloads(apk, file + ".apk")); where = "Downloads/zenvqo/" + file + ".apk"; }
                    catch (Exception e) { Log.w(TAG, "save to Downloads failed", e); }
                }
                JSONObject r = new JSONObject().put("pkg", pkg).put("name", label).put("size", apk.length).put("saved", where);
                send(id, "built", r.toString());
            } catch (Throwable t) {
                Log.e(TAG, "build failed", t);
                send(id, "error", "Couldn't make the app (" + t.getClass().getSimpleName() + (t.getMessage() != null ? ": " + t.getMessage() : "") + ").");
            }
        });
    }

    /** The system's install screen (the user confirms; the first time Android asks to allow installs from zenvqo). */
    @JavascriptInterface
    public void install(final String id) {
        final File f = built.get(id);
        if (f == null) { send(id, "install-failed", "Make the app again first."); return; }
        worker.execute(() -> {
            try {
                listen();
                PackageInstaller pi = activity.getPackageManager().getPackageInstaller();
                PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
                params.setAppPackageName(pkgs.get(id));
                int sid = pi.createSession(params);
                try (PackageInstaller.Session s = pi.openSession(sid)) {
                    try (OutputStream out = s.openWrite("app.apk", 0, f.length()); InputStream in = new java.io.FileInputStream(f)) {
                        byte[] buf = new byte[65536];
                        int n;
                        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                        s.fsync(out);
                    }
                    Intent cb = new Intent(ACTION).setPackage(activity.getPackageName()).putExtra("zid", id);
                    int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
                    PendingIntent pend = PendingIntent.getBroadcast(activity, sid, cb, flags);
                    s.commit(pend.getIntentSender());
                }
            } catch (Throwable t) {
                Log.e(TAG, "install failed", t);
                send(id, "install-failed", "Couldn't start installing (" + t.getClass().getSimpleName() + ").");
            }
        });
    }

    private synchronized void listen() {
        if (listening) return;
        listening = true;
        BroadcastReceiver r = new BroadcastReceiver() {
            @Override public void onReceive(Context c, Intent i) {
                String id = i.getStringExtra("zid");
                int st = i.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
                if (st == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                    Intent confirm = i.getParcelableExtra(Intent.EXTRA_INTENT);
                    if (confirm != null) {
                        confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        try { activity.startActivity(confirm); } catch (Exception e) { send(id, "install-failed", "The install screen couldn't open."); }
                    }
                    return;
                }
                if (st == PackageInstaller.STATUS_SUCCESS) send(id, "installed", "");
                else if (st == PackageInstaller.STATUS_FAILURE_ABORTED) send(id, "install-failed", "Installing was cancelled.");
                else {
                    String m = i.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
                    send(id, "install-failed", st == PackageInstaller.STATUS_FAILURE_CONFLICT
                            ? "An app with this name is already installed with a different signature. Uninstall it first."
                            : "Android couldn't install it" + (m != null ? " (" + m + ")" : "") + ".");
                }
            }
        };
        IntentFilter f = new IntentFilter(ACTION);
        if (Build.VERSION.SDK_INT >= 33) activity.registerReceiver(r, f, Context.RECEIVER_NOT_EXPORTED);   // sent through our own PendingIntent
        else activity.registerReceiver(r, f);
    }

    @JavascriptInterface
    public void open(String id) {
        final String pkg = pkgs.get(id);
        activity.runOnUiThread(() -> {
            Intent i = pkg == null ? null : activity.getPackageManager().getLaunchIntentForPackage(pkg);
            if (i == null) { toast("Install the app first."); return; }
            activity.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        });
    }

    @JavascriptInterface
    public boolean installed(String id) {
        String pkg = pkgs.get(id);
        if (pkg == null) return false;
        try { activity.getPackageManager().getPackageInfo(pkg, 0); return true; } catch (PackageManager.NameNotFoundException e) { return false; }
    }

    @JavascriptInterface
    public void share(String id) {
        final Uri uri = saved.get(id);
        final String label = names.get(id);
        activity.runOnUiThread(() -> {
            if (uri == null) { toast("Sharing needs Android 10 or newer."); return; }
            Intent i = new Intent(Intent.ACTION_SEND).setType("application/vnd.android.package-archive").putExtra(Intent.EXTRA_STREAM, uri)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            activity.startActivity(Intent.createChooser(i, "Share " + (label == null ? "app" : label)));
        });
    }

    /* ---------------- helpers ---------------- */
    private KeyStore signingKey() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (!ks.containsAlias(KEY_ALIAS)) {
            Calendar from = Calendar.getInstance(), to = Calendar.getInstance();
            from.add(Calendar.DAY_OF_YEAR, -1);
            to.add(Calendar.YEAR, 30);
            KeyPairGenerator g = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA, "AndroidKeyStore");
            g.initialize(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_SIGN)
                    .setKeySize(2048)
                    .setDigests(KeyProperties.DIGEST_SHA256)
                    .setSignaturePaddings(KeyProperties.SIGNATURE_PADDING_RSA_PKCS1)
                    .setCertificateSubject(new X500Principal("CN=zenvqo web apps"))
                    .setCertificateSerialNumber(BigInteger.valueOf(System.currentTimeMillis()))
                    .setCertificateNotBefore(from.getTime())
                    .setCertificateNotAfter(to.getTime())
                    .build());
            g.generateKeyPair();
        }
        return ks;
    }

    /** A square launcher icon: the user's picture, centre-cropped. */
    private static byte[] iconFromImage(byte[] img) { return iconFromImage(img, 192); }

    static byte[] iconFromImage(byte[] img, int size) {
        Bitmap src = BitmapFactory.decodeByteArray(img, 0, img.length);
        if (src == null) return null;
        int s = Math.min(src.getWidth(), src.getHeight());
        Bitmap out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(out);
        android.graphics.Rect from = new android.graphics.Rect((src.getWidth() - s) / 2, (src.getHeight() - s) / 2, (src.getWidth() + s) / 2, (src.getHeight() + s) / 2);
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
        c.drawBitmap(src, from, new RectF(0, 0, size, size), p);
        return png(out);
    }

    /** The app name's first letter on a colour picked from the name. */
    private static byte[] letterIcon(String label) { return letterIcon(label, 192, true); }

    static int letterColour(String label) {
        int[] colours = {0xFF0060E6, 0xFF1F4E8C, 0xFF7A3E9D, 0xFFB4441F, 0xFF2E7D32, 0xFF8C5A00, 0xFF00796B, 0xFF37474F};
        return colours[Math.abs(label.hashCode()) % colours.length];
    }

    /** The app name's first letter on a colour picked from the name (rounded for a launcher icon, square for the Play listing,
     *  which rounds icons itself). */
    static byte[] letterIcon(String label, int size, boolean rounded) {
        Bitmap out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(out);
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setColor(letterColour(label));
        if (rounded) c.drawRoundRect(new RectF(0, 0, size, size), size * 44f / 192, size * 44f / 192, p);
        else c.drawRect(0, 0, size, size, p);
        String ch = label.substring(0, label.offsetByCodePoints(0, 1)).toUpperCase(java.util.Locale.ROOT);
        p.setColor(0xFFFFFFFF);
        p.setTextSize(size * 108f / 192);
        p.setTypeface(Typeface.create(Typeface.DEFAULT, Typeface.BOLD));
        p.setTextAlign(Paint.Align.CENTER);
        Paint.FontMetrics fm = p.getFontMetrics();
        c.drawText(ch, size / 2f, size / 2f - (fm.ascent + fm.descent) / 2, p);
        return png(out);
    }

    static byte[] png(Bitmap b) {
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        b.compress(Bitmap.CompressFormat.PNG, 100, o);
        return o.toByteArray();
    }

    private Uri toDownloads(byte[] data, String name) throws Exception {
        ContentResolver r = activity.getContentResolver();
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        v.put(MediaStore.MediaColumns.MIME_TYPE, "application/vnd.android.package-archive");
        v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/zenvqo");
        v.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri uri = r.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
        if (uri == null) throw new IllegalStateException("insert failed");
        try (OutputStream out = r.openOutputStream(uri)) {
            if (out == null) throw new IllegalStateException("no stream");
            out.write(data);
        }
        v.clear();
        v.put(MediaStore.MediaColumns.IS_PENDING, 0);
        r.update(uri, v, null, null);
        return uri;
    }

    static byte[] readAll(InputStream in) throws Exception {
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        byte[] buf = new byte[65536];
        int n;
        while ((n = in.read(buf)) > 0) o.write(buf, 0, n);
        return o.toByteArray();
    }

    private void toast(String s) { Toast.makeText(activity, s, Toast.LENGTH_SHORT).show(); }

    private void send(String id, String ev, String data) {
        Log.i(TAG, id + " -> " + ev + " " + data);
        final String js = "window.__zapk&&window.__zapk(" + JSONObject.quote(id) + "," + JSONObject.quote(ev) + "," + JSONObject.quote(data) + ")";
        web.post(() -> web.evaluateJavascript(js, null));
    }
}
