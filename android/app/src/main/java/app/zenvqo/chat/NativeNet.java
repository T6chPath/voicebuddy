package app.zenvqo.chat;

import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONObject;

import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.Reader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * HTTP for the web app, done natively so AI services that send no CORS headers still work.
 * Exposed to JavaScript as window.ZenvqoNative. Results stream back through window.__zn(id, kind, data):
 * "head" {status} → "data" text chunks → "end", or "error" message.
 * The WebView only ever shows the bundled app (all other pages open in the browser), so only our code can call this.
 */
final class NativeNet {
    private final WebView web;
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private final Map<String, HttpURLConnection> live = new ConcurrentHashMap<>();
    private final Map<String, Boolean> cancelled = new ConcurrentHashMap<>();

    NativeNet(WebView web) {
        this.web = web;
    }

    @JavascriptInterface
    public void request(final String id, final String url, final String method, final String headersJson, final String body) {
        pool.execute(() -> run(id, url, method, headersJson, body));
    }

    @JavascriptInterface
    public void cancel(String id) {
        cancelled.put(id, Boolean.TRUE);
        HttpURLConnection c = live.remove(id);
        if (c != null) c.disconnect();
    }

    void shutdown() {
        for (HttpURLConnection c : live.values()) c.disconnect();
        live.clear();
        pool.shutdownNow();
    }

    private void run(String id, String url, String method, String headersJson, String body) {
        HttpURLConnection c = null;
        try {
            URL u = new URL(url);
            String scheme = u.getProtocol();
            if (!"http".equals(scheme) && !"https".equals(scheme)) throw new IllegalArgumentException("Only http and https addresses are allowed.");
            String m = "POST".equals(method) ? "POST" : "GET";
            c = (HttpURLConnection) u.openConnection();
            live.put(id, c);
            c.setConnectTimeout(15000);
            c.setReadTimeout(120000);
            c.setRequestMethod(m);
            c.setUseCaches(false);
            boolean binary = false;                                     // images: the page asks for the raw bytes
            if (headersJson != null && !headersJson.isEmpty()) {
                JSONObject h = new JSONObject(headersJson);
                Iterator<String> keys = h.keys();
                while (keys.hasNext()) {
                    String k = keys.next();
                    if ("X-Zenvqo-Binary".equalsIgnoreCase(k)) { binary = true; continue; }
                    c.setRequestProperty(k, h.optString(k));
                }
            }
            if ("POST".equals(m)) {
                byte[] bytes = (body == null ? "" : body).getBytes(StandardCharsets.UTF_8);
                c.setDoOutput(true);
                c.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream os = c.getOutputStream()) {
                    os.write(bytes);
                }
            }
            int status = c.getResponseCode();
            String type = c.getContentType();
            send(id, "head", "{\"status\":" + status + ",\"type\":" + quote(type == null ? "" : type) + "}");
            InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
            if (in != null && binary && status < 400) {
                byte[] buf = new byte[49152];                               // base64 chunks of 64 KB
                int n;
                try {
                    while ((n = readFully(in, buf)) > 0) {
                        if (cancelled.containsKey(id)) break;
                        send(id, "data64", android.util.Base64.encodeToString(buf, 0, n, android.util.Base64.NO_WRAP));
                    }
                } finally {
                    in.close();
                }
            } else if (in != null) {
                try (Reader r = new InputStreamReader(in, StandardCharsets.UTF_8)) {
                    char[] buf = new char[4096];
                    int n;
                    while ((n = r.read(buf)) > 0) {
                        if (cancelled.containsKey(id)) break;
                        send(id, "data", new String(buf, 0, n));
                    }
                }
            }
            if (!cancelled.containsKey(id)) send(id, "end", "");
        } catch (Exception e) {
            if (!cancelled.containsKey(id)) {
                String msg = e.getMessage();
                send(id, "error", msg == null || msg.isEmpty() ? e.getClass().getSimpleName() : msg);
            }
        } finally {
            live.remove(id);
            cancelled.remove(id);
            if (c != null) c.disconnect();
        }
    }

    private static int readFully(InputStream in, byte[] buf) throws java.io.IOException {
        int total = 0, n;
        while (total < buf.length && (n = in.read(buf, total, buf.length - total)) > 0) total += n;
        return total;
    }

    private void send(String id, String kind, String data) {
        final String js = "window.__zn&&window.__zn(" + quote(id) + "," + quote(kind) + "," + quote(data) + ")";
        web.post(() -> web.evaluateJavascript(js, null));
    }

    private static String quote(String s) {
        return JSONObject.quote(s).replace("\u2028", "\\u2028").replace("\u2029", "\\u2029");
    }
}
