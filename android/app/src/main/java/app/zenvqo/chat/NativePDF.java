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
import android.print.PdfPrint;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.provider.MediaStore;
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
import java.util.Map;

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

    NativePDF(Activity activity, WebView web) {
        this.activity = activity;
        this.web = web;
    }

    @JavascriptInterface
    public void save(final String id, final String html, final String fileName) {
        final String name = fileName.endsWith(".pdf") ? fileName : fileName + ".pdf";
        activity.runOnUiThread(() -> {
            WebView w = new WebView(activity);
            w.getSettings().setJavaScriptEnabled(false);              // the document is static HTML
            w.getSettings().setAllowFileAccess(false);
            w.getSettings().setAllowContentAccess(false);
            rendering.put(id, w);
            w.setWebViewClient(new WebViewClient() {
                private boolean started;

                @Override
                public void onPageFinished(WebView view, String url) {
                    if (started) return;
                    started = true;
                    view.postDelayed(() -> print(id, view, name), 400);   // let fonts and layout settle
                }
            });
            w.loadDataWithBaseURL("https://zenvqo.local/", html, "text/html", "utf-8", null);
        });
    }

    private void print(String id, WebView view, String name) {
        PrintDocumentAdapter adapter = view.createPrintDocumentAdapter(name);
        PrintAttributes attrs = new PrintAttributes.Builder()
                .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
                .setResolution(new PrintAttributes.Resolution("pdf", "pdf", 600, 600))
                .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
                .build();
        if (Build.VERSION.SDK_INT < 29) {
            PrintManager pm = (PrintManager) activity.getSystemService(Context.PRINT_SERVICE);
            pm.print(name, adapter, attrs);
            rendering.remove(id);
            send(id, "dialog", "");
            return;
        }
        final File tmp = new File(activity.getCacheDir(), "pdf/" + id + ".pdf");
        PdfPrint.write(adapter, attrs, tmp, error -> {
            rendering.remove(id);
            if (error != null) {
                send(id, "error", error);
                return;
            }
            try {
                Uri uri = toDownloads(tmp, name);
                files.put(id, uri);
                send(id, "saved", "Downloads/zenvqo");
            } catch (Exception e) {
                send(id, "error", "Couldn't save to Downloads.");
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
        v.put(MediaStore.MediaColumns.MIME_TYPE, "application/pdf");
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
        final String js = "window.__zpdf&&window.__zpdf(" + JSONObject.quote(id) + "," + JSONObject.quote(status) + "," + JSONObject.quote(data) + ")";
        web.post(() -> web.evaluateJavascript(js, null));
    }
}
