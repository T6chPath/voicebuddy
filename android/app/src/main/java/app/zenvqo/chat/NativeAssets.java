package app.zenvqo.chat;

import android.app.Activity;
import android.util.Base64;
import android.webkit.JavascriptInterface;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;

/**
 * Data files the PDF reader (pdf.js) needs for some PDFs: Adobe CMaps (Chinese/Japanese/Korean fonts), the standard
 * PDF fonts, and the JPEG 2000 / JBIG2 image decoders used by many scanned PDFs. They ship in assets/pdfjs/ and are
 * handed to the page as base64 when a PDF needs them. Exposed as window.ZenvqoAssets; only files under pdfjs/ are
 * readable.
 */
final class NativeAssets {
    private final Activity activity;

    NativeAssets(Activity activity) {
        this.activity = activity;
    }

    @JavascriptInterface
    public String read(String path) {
        if (path == null || !path.startsWith("pdfjs/") || path.contains("..") || path.contains("\\")) return null;
        try (InputStream in = activity.getAssets().open(path); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[32768];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
        } catch (Exception e) {
            return null;
        }
    }
}
