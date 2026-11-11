package app.zenvqo.chat;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.os.Build;
import android.util.Base64;
import android.webkit.JavascriptInterface;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;

/**
 * Data files the PDF reader (pdf.js) needs for some PDFs: Adobe CMaps (Chinese/Japanese/Korean fonts), the standard
 * PDF fonts, and the JPEG 2000 / JBIG2 image decoders used by many scanned PDFs. They ship in assets/pdfjs/ and are
 * handed to the page as base64 when a PDF needs them. Exposed as window.ZenvqoAssets; only files under pdfjs/ are
 * readable. Also converts pictures the WebView can't show (HEIC…) to JPEG.
 */
final class NativeAssets {
    private final Activity activity;

    NativeAssets(Activity activity) {
        this.activity = activity;
    }

    /**
     * Pictures the WebView can't open (iPhone HEIC/HEIF on Android 9+, AVIF on 12+, and anything else Android's own
     * decoders handle) → a JPEG, at most maxSide pixels on the long side, as base64; "" if Android can't decode it either.
     */
    @JavascriptInterface
    public String toJpeg(String base64, int maxSide) {
        try {
            byte[] in = Base64.decode(base64, Base64.DEFAULT);
            BitmapFactory.Options probe = new BitmapFactory.Options();
            probe.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(in, 0, in.length, probe);
            int side = Math.max(probe.outWidth, probe.outHeight), sample = 1;
            while (side / (sample * 2) >= maxSide) sample *= 2;           // decode smaller: phone photos are huge
            BitmapFactory.Options o = new BitmapFactory.Options();
            o.inSampleSize = sample;
            Bitmap b = null;
            if (Build.VERSION.SDK_INT >= 28) {
                try {
                    b = android.graphics.ImageDecoder.decodeBitmap(android.graphics.ImageDecoder.createSource(java.nio.ByteBuffer.wrap(in)),
                            (dec, info, src) -> { dec.setTargetSampleSize(Math.max(1, sample2(info.getSize().getWidth(), info.getSize().getHeight(), maxSide)));
                                                  dec.setAllocator(android.graphics.ImageDecoder.ALLOCATOR_SOFTWARE); });
                } catch (Throwable t) { b = null; }
            }
            if (b == null) b = BitmapFactory.decodeByteArray(in, 0, in.length, o);
            if (b == null) return "";
            float k = Math.min(1f, maxSide / (float) Math.max(b.getWidth(), b.getHeight()));
            int w = Math.max(1, Math.round(b.getWidth() * k)), h = Math.max(1, Math.round(b.getHeight() * k));
            Bitmap out = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
            Canvas c = new Canvas(out);
            c.drawColor(Color.WHITE);                                     // transparent pictures on white
            c.drawBitmap(Bitmap.createScaledBitmap(b, w, h, true), 0, 0, null);
            ByteArrayOutputStream jpg = new ByteArrayOutputStream();
            out.compress(Bitmap.CompressFormat.JPEG, 88, jpg);
            return Base64.encodeToString(jpg.toByteArray(), Base64.NO_WRAP);
        } catch (Throwable t) {
            return "";
        }
    }

    private static int sample2(int w, int h, int maxSide) {
        int side = Math.max(w, h), s = 1;
        while (side / (s * 2) >= maxSide) s *= 2;
        return s;
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
