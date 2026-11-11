package app.zenvqo.chat;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.print.PdfPrint;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.provider.MediaStore;
import android.util.Log;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * Turns a reply into a real PDF. Exposed as window.ZenvqoPDF.
 * The page is rendered in an off-screen WebView and printed by Android's own engine (so math, tables and Hindi come out
 * exactly as on screen). Android 10+: written straight to Downloads/zenvqo (no storage permission needed) and can be
 * opened or shared. Android 7–9: the system print screen opens, where "Save as PDF" is the default printer.
 * Result: window.__zpdf(id, "saved"|"dialog"|"error", detail).
 */
final class NativePDF {
    private final Activity activity;
    private final WebView web;
    private final Map<String, Uri> files = new HashMap<>();
    private final Map<String, WebView> rendering = new HashMap<>();
    private final Set<String> answered = new HashSet<>();
    private static final String TAG = "ZenvqoPDF";

    NativePDF(Activity activity, WebView web) {
        this.activity = activity;
        this.web = web;
    }

    // The renderer is never attached to the screen, and Android holds View.post/postDelayed tasks of a detached view
    // until it is attached — i.e. forever. All timing therefore goes through a main-thread Handler.
    private final Handler main = new Handler(Looper.getMainLooper());

    private final java.util.List<WebView> printing = new java.util.ArrayList<>();

    private WebView newRenderer() {
        WebView w = new WebView(activity);
        w.getSettings().setJavaScriptEnabled(false);              // the document is static HTML
        w.getSettings().setAllowFileAccess(false);
        w.getSettings().setAllowContentAccess(false);
        // give the detached view a page-sized box so layout happens as it would on screen
        int width = 1240, height = 1754;
        w.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
                  View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY));
        w.layout(0, 0, width, height);
        return w;
    }

    @JavascriptInterface
    public void save(final String id, final String html, final String fileName) {
        final String name = fileName.endsWith(".pdf") ? fileName : fileName + ".pdf";
        Log.i(TAG, "PDF " + id + ": " + html.length() + " chars → " + name);
        activity.runOnUiThread(() -> {
            final WebView w;
            try {
                w = newRenderer();
            } catch (Throwable t) {
                fail(id, "This phone's PDF engine failed (" + t.getClass().getSimpleName() + ").", t);
                return;
            }
            rendering.put(id, w);
            w.setWebViewClient(new WebViewClient() {
                private boolean started;

                @Override
                public void onPageFinished(WebView view, String url) {
                    if (started) return;
                    started = true;
                    Log.i(TAG, "PDF " + id + ": page loaded");
                    main.postDelayed(() -> print(id, view, name), 60);   // one frame for layout; fonts are inline
                }
            });
            w.loadDataWithBaseURL("https://zenvqo.local/", html, "text/html", "utf-8", null);
            // never leave the page waiting: if the engine doesn't answer, say so
            main.postDelayed(() -> {
                WebView stuck = rendering.remove(id);
                if (stuck != null) {
                    fail(id, "Creating the PDF took too long. Try again.", null);
                    stuck.destroy();
                }
            }, 30_000);
        });
    }

    /** Fallback: a PDF the page drew itself (base64), written to Downloads/zenvqo like the engine's files. */
    @JavascriptInterface
    public void saveBytes(final String id, final String base64, final String fileName) {
        final String name = fileName.matches("(?i).+\\.(pdf|png|jpe?g|webp)$") ? fileName : fileName + ".pdf";   // PDFs, graphs, pictures
        if (Build.VERSION.SDK_INT < 29) { fail(id, "Saving files needs Android 10 or newer.", null); return; }
        try {
            byte[] bytes = android.util.Base64.decode(base64, android.util.Base64.DEFAULT);
            File tmp = new File(activity.getCacheDir(), "pdf/" + id + ".pdf");
            //noinspection ResultOfMethodCallIgnored
            tmp.getParentFile().mkdirs();
            try (OutputStream out = new java.io.FileOutputStream(tmp)) { out.write(bytes); }
            try {
                Uri uri = toDownloads(tmp, name);
                files.put(id, uri);
                send(id, "saved", "Downloads/zenvqo");
            } finally {
                //noinspection ResultOfMethodCallIgnored
                tmp.delete();
            }
        } catch (Throwable t) {
            fail(id, "Couldn't save to Downloads.", t);
        }
    }

    private void fail(String id, String msg, Throwable t) {
        Log.e(TAG, "PDF " + id + ": " + msg, t);
        send(id, "error", msg);
    }

    private void print(String id, WebView view, String name) {
        try {
            printNow(id, view, name);
        } catch (Throwable t) {                                    // incl. errors from the print framework on some devices
            rendering.remove(id);
            fail(id, "This phone's PDF engine failed (" + t.getClass().getSimpleName() + ").", t);
        }
    }

    private void printNow(String id, WebView view, String name) {
        PrintDocumentAdapter adapter = view.createPrintDocumentAdapter(name);
        PrintAttributes attrs = new PrintAttributes.Builder()
                .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
                .setResolution(new PrintAttributes.Resolution("pdf", "pdf", 600, 600))
                .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
                .build();
        if (Build.VERSION.SDK_INT < 29) {
            PrintManager pm = (PrintManager) activity.getSystemService(Context.PRINT_SERVICE);
            pm.print(name, adapter, attrs);
            printing.add(rendering.remove(id));                     // the print screen still uses this view
            send(id, "dialog", "");
            return;
        }
        final File tmp = new File(activity.getCacheDir(), "pdf/" + id + ".pdf");
        PdfPrint.write(adapter, attrs, tmp, error -> {
            WebView done = rendering.remove(id);
            if (done != null) main.post(done::destroy);
            if (error != null) {
                fail(id, error, null);
                return;
            }
            try {
                Uri uri = toDownloads(tmp, name);
                files.put(id, uri);
                send(id, "saved", "Downloads/zenvqo");
            } catch (Throwable e) {
                fail(id, "Couldn't save to Downloads.", e);
            } finally {
                //noinspection ResultOfMethodCallIgnored
                tmp.delete();
            }
        });
    }

    private Uri toDownloads(File src, String name) throws Exception {
        ContentResolver r = activity.getContentResolver();
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        String lower = name.toLowerCase(java.util.Locale.ROOT);
        v.put(MediaStore.MediaColumns.MIME_TYPE, lower.endsWith(".png") ? "image/png" : lower.endsWith(".webp") ? "image/webp"
                : lower.endsWith(".jpg") || lower.endsWith(".jpeg") ? "image/jpeg" : "application/pdf");
        v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/zenvqo");
        v.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri uri = r.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
        if (uri == null) throw new IllegalStateException("insert failed");
        try (InputStream in = new FileInputStream(src); OutputStream out = r.openOutputStream(uri)) {
            if (out == null) throw new IllegalStateException("no stream");
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
        v.clear();
        v.put(MediaStore.MediaColumns.IS_PENDING, 0);
        r.update(uri, v, null, null);
        return uri;
    }

    @JavascriptInterface
    public void open(String id) {
        final Uri uri = files.get(id);
        activity.runOnUiThread(() -> {
            if (uri == null) { toast("This PDF is in Downloads/zenvqo."); return; }
            Intent i = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/pdf")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            try { activity.startActivity(i); } catch (ActivityNotFoundException e) { toast("No PDF viewer is installed."); }
        });
    }

    @JavascriptInterface
    public void share(String id) {
        final Uri uri = files.get(id);
        activity.runOnUiThread(() -> {
            if (uri == null) { toast("This PDF is in Downloads/zenvqo."); return; }
            Intent i = new Intent(Intent.ACTION_SEND).setType("application/pdf").putExtra(Intent.EXTRA_STREAM, uri)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            activity.startActivity(Intent.createChooser(i, "Share PDF"));
        });
    }

    private void toast(String s) {
        Toast.makeText(activity, s, Toast.LENGTH_SHORT).show();
    }

    private void send(String id, String status, String data) {
        synchronized (answered) { if (!answered.add(id)) return; }     // one answer per PDF
        Log.i(TAG, "PDF " + id + " -> " + status + " " + data);
        final String js = "window.__zpdf&&window.__zpdf(" + JSONObject.quote(id) + "," + JSONObject.quote(status) + "," + JSONObject.quote(data) + ")";
        web.post(() -> web.evaluateJavascript(js, null));
    }
}
