package app.zenvqo.chat;

import android.app.Activity;
import android.app.ActivityManager;
import android.content.Context;
import android.os.Build;
import android.os.StatFs;
import android.util.Base64;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.RandomAccessFile;
import java.io.Reader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Makes pictures on the phone itself, with no service: the bundled stable-diffusion.cpp program (libsdcli.so,
 * installed next to the app's code) runs a small image model (SD-Turbo) that the user downloads once.
 * Exposed to JavaScript as window.ZenvqoImageGen; results come back through window.__zig(kind, json):
 *   "dl"      {name, done, total}            model download progress
 *   "dlend"   {name}  /  "dlerr" {name, error}
 *   "gen"     {id, phase, step, steps}       phase: load | text | sample | decode
 *   "img"     {id, chunk}                    the PNG, base64, in pieces
 *   "genend"  {id, ms}  /  "generr" {id, error, log}
 */
final class NativeImageGen {
    private static final Pattern STEP = Pattern.compile("\\|\\s*(\\d+)/(\\d+)\\b");
    private static final Pattern SAFE_NAME = Pattern.compile("[A-Za-z0-9._-]{1,80}");

    private final Activity activity;
    private final WebView web;
    private final File dir;
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private volatile String downloading = null;
    private volatile boolean stopDownload = false;
    private volatile Process running = null;
    private volatile String runningId = null;

    NativeImageGen(Activity activity, WebView web) {
        this.activity = activity;
        this.web = web;
        this.dir = new File(activity.getFilesDir(), "image-models");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
    }

    private File engine() {
        return new File(activity.getApplicationInfo().nativeLibraryDir, "libsdcli.so");
    }

    /* ---------------- status ---------------- */
    @JavascriptInterface
    public String info() {
        try {
            JSONObject o = new JSONObject();
            o.put("engine", engine().exists());
            o.put("abi", Build.SUPPORTED_ABIS.length > 0 ? Build.SUPPORTED_ABIS[0] : "");
            o.put("cores", Runtime.getRuntime().availableProcessors());
            ActivityManager am = (ActivityManager) activity.getSystemService(Context.ACTIVITY_SERVICE);
            ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
            am.getMemoryInfo(mi);
            o.put("ramMB", mi.totalMem / (1024 * 1024));
            o.put("availMB", mi.availMem / (1024 * 1024));
            StatFs fs = new StatFs(dir.getAbsolutePath());
            o.put("freeMB", fs.getAvailableBytes() / (1024 * 1024));
            JSONObject files = new JSONObject();
            File[] list = dir.listFiles();
            if (list != null) for (File f : list) if (f.isFile()) files.put(f.getName(), f.length());
            o.put("files", files);
            o.put("downloading", downloading == null ? JSONObject.NULL : downloading);
            o.put("busy", running != null);
            return o.toString();
        } catch (Exception e) {
            return "{\"engine\":false,\"error\":" + JSONObject.quote(String.valueOf(e.getMessage())) + "}";
        }
    }

    /* ---------------- model download (resumable) ---------------- */
    @JavascriptInterface
    public boolean download(final String name, final String url, final double expected) {
        if (!SAFE_NAME.matcher(name).matches() || !url.startsWith("https://")) return false;
        String host;
        try { host = new URL(url).getHost(); } catch (Exception e) { return false; }
        if (!(host.equals("github.com") || host.equals("huggingface.co") || host.endsWith(".huggingface.co") || host.endsWith(".hf.co")))
            return false;                                   // models only come from these two places
        if (downloading != null) return false;
        downloading = name;
        stopDownload = false;
        pool.execute(() -> fetch(name, url, (long) expected));
        return true;
    }

    @JavascriptInterface
    public void cancelDownload() {
        stopDownload = true;
    }

    @JavascriptInterface
    public boolean remove(String name) {
        if (!SAFE_NAME.matcher(name).matches()) return false;
        File f = new File(dir, name);
        File p = new File(dir, name + ".part");
        boolean ok = !f.exists() || f.delete();
        if (p.exists()) //noinspection ResultOfMethodCallIgnored
            p.delete();
        return ok;
    }

    private void fetch(String name, String url, long expected) {
        File part = new File(dir, name + ".part");
        File done = new File(dir, name);
        HttpURLConnection c = null;
        try {
            for (int attempt = 0; ; attempt++) {
                long have = part.exists() ? part.length() : 0;
                c = (HttpURLConnection) new URL(url).openConnection();
                c.setInstanceFollowRedirects(true);
                c.setConnectTimeout(20000);
                c.setReadTimeout(60000);
                c.setRequestProperty("User-Agent", "zenvqo-chat");
                if (have > 0) c.setRequestProperty("Range", "bytes=" + have + "-");
                int status = c.getResponseCode();
                if (status == 416 && have > 0 && expected > 0 && have >= expected * 0.98) break;   // already complete
                if (status != 200 && status != 206) throw new java.io.IOException("the download server answered " + status);
                boolean append = status == 206;
                long total = append ? have + Math.max(0, c.getContentLengthLong()) : Math.max(0, c.getContentLengthLong());
                if (total <= 0) total = expected;
                long got = append ? have : 0;
                long last = 0;
                try (InputStream in = c.getInputStream(); FileOutputStream out = new FileOutputStream(part, append)) {
                    byte[] buf = new byte[1 << 16];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        if (stopDownload) throw new InterruptedException("cancelled");
                        out.write(buf, 0, n);
                        got += n;
                        long now = System.currentTimeMillis();
                        if (now - last > 400) {
                            last = now;
                            emit("dl", "{\"name\":" + JSONObject.quote(name) + ",\"done\":" + got + ",\"total\":" + total + "}");
                        }
                    }
                } catch (java.io.IOException e) {
                    if (attempt < 5 && !stopDownload) { c.disconnect(); Thread.sleep(2000L * (attempt + 1)); continue; }   // resume
                    throw e;
                }
                if (total > 0 && got < total) {
                    if (attempt < 5) { c.disconnect(); continue; }
                    throw new java.io.IOException("the download stopped early");
                }
                break;
            }
            if (done.exists()) //noinspection ResultOfMethodCallIgnored
                done.delete();
            if (!part.renameTo(done)) throw new java.io.IOException("couldn't save the file");
            emit("dlend", "{\"name\":" + JSONObject.quote(name) + ",\"bytes\":" + done.length() + "}");
        } catch (InterruptedException e) {
            emit("dlerr", "{\"name\":" + JSONObject.quote(name) + ",\"error\":\"cancelled\"}");
        } catch (Exception e) {
            String msg = e.getMessage();
            emit("dlerr", "{\"name\":" + JSONObject.quote(name) + ",\"error\":" + JSONObject.quote(msg == null ? e.getClass().getSimpleName() : msg) + "}");
        } finally {
            if (c != null) c.disconnect();
            downloading = null;
        }
    }

    /* ---------------- making a picture ---------------- */
    @JavascriptInterface
    public boolean generate(final String id, final String json) {
        if (running != null) return false;
        runningId = id;
        pool.execute(() -> run(id, json));
        return true;
    }

    @JavascriptInterface
    public void cancel(String id) {
        Process p = running;
        if (p != null && (id == null || id.equals(runningId))) p.destroy();
    }

    void shutdown() {
        stopDownload = true;
        Process p = running;
        if (p != null) p.destroy();
        pool.shutdownNow();
    }

    private static String num(JSONObject a, String k, double d) {
        double v = a.optDouble(k, d);
        return v == Math.rint(v) ? String.valueOf((long) v) : String.format(Locale.US, "%.3f", v);
    }

    private static int threads() {
        int cores = Runtime.getRuntime().availableProcessors();
        // the fast cores: on 8-core phones that's usually 4 (more threads only queue behind the slow cores)
        return cores >= 8 ? 4 : Math.max(1, Math.min(4, cores));
    }

    private void run(String id, String json) {
        long t0 = System.currentTimeMillis();
        File work = new File(activity.getCacheDir(), "imagegen");
        //noinspection ResultOfMethodCallIgnored
        work.mkdirs();
        File out = new File(work, "out-" + id.replaceAll("[^A-Za-z0-9_-]", "") + ".png");
        File init = new File(work, "init.png"), mask = new File(work, "mask.png");
        ArrayDeque<String> tail = new ArrayDeque<>();
        keepScreenOn(true);
        try {
            JSONObject a = new JSONObject(json);
            String modelName = a.getString("model");
            if (!SAFE_NAME.matcher(modelName).matches()) throw new IllegalArgumentException("bad model name");
            File model = new File(dir, modelName);
            if (!model.exists()) throw new IllegalStateException("The picture model isn't downloaded yet.");
            if (!engine().exists()) throw new IllegalStateException("This copy of the app has no picture engine for this phone.");
            List<String> cmd = new ArrayList<>();
            cmd.add(engine().getAbsolutePath());
            cmd.add("-m"); cmd.add(model.getAbsolutePath());
            cmd.add("-p"); cmd.add(a.getString("prompt"));
            String neg = a.optString("negative", "");
            if (!neg.isEmpty()) { cmd.add("-n"); cmd.add(neg); }
            cmd.add("-W"); cmd.add(num(a, "width", 512));
            cmd.add("-H"); cmd.add(num(a, "height", 512));
            cmd.add("--steps"); cmd.add(num(a, "steps", 2));
            cmd.add("--cfg-scale"); cmd.add(num(a, "cfg", 1));
            cmd.add("--sampling-method"); cmd.add(a.optString("sampler", "euler_a"));
            cmd.add("-s"); cmd.add(num(a, "seed", 42));
            cmd.add("-t"); cmd.add(String.valueOf(a.optInt("threads", threads())));
            cmd.add("--mmap");
            String tae = a.optString("taesd", "");
            if (!tae.isEmpty() && SAFE_NAME.matcher(tae).matches() && new File(dir, tae).exists()) {
                cmd.add("--taesd"); cmd.add(new File(dir, tae).getAbsolutePath());
            }
            if (a.has("init")) {
                write(init, a.getString("init"));
                cmd.add("-i"); cmd.add(init.getAbsolutePath());
                cmd.add("--strength"); cmd.add(num(a, "strength", 0.6));
                if (a.has("mask")) { write(mask, a.getString("mask")); cmd.add("--mask"); cmd.add(mask.getAbsolutePath()); }
            }
            cmd.add("-o"); cmd.add(out.getAbsolutePath());
            if (out.exists()) //noinspection ResultOfMethodCallIgnored
                out.delete();

            ProcessBuilder pb = new ProcessBuilder(cmd).directory(work).redirectErrorStream(true);
            pb.environment().put("LD_LIBRARY_PATH", activity.getApplicationInfo().nativeLibraryDir);
            emit("gen", "{\"id\":" + JSONObject.quote(id) + ",\"phase\":\"load\",\"step\":0,\"steps\":0}");
            Process p = pb.start();
            running = p;
            String phase = "load";
            try (Reader r = new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8)) {
                StringBuilder line = new StringBuilder();
                int ch;
                while ((ch = r.read()) != -1) {
                    if (ch != '\n' && ch != '\r') { if (line.length() < 2000) line.append((char) ch); continue; }
                    String s = line.toString().trim();
                    line.setLength(0);
                    if (s.isEmpty()) continue;
                    if (tail.size() >= 30) tail.removeFirst();
                    tail.addLast(s);
                    String low = s.toLowerCase(Locale.US);
                    String next = phase;
                    if (low.contains("get_learned_condition") || low.contains("conditioning") || low.contains("text encoder")) next = "text";
                    if (low.contains("sampling") || low.contains("generating image")) next = "sample";
                    if (low.contains("decod")) next = "decode";
                    Matcher m = STEP.matcher(s);
                    if (m.find() && !s.contains("MB/s") && !s.contains("GB/s")) {
                        if (!"decode".equals(phase)) next = "sample";
                        emit("gen", "{\"id\":" + JSONObject.quote(id) + ",\"phase\":\"" + next + "\",\"step\":" + m.group(1) + ",\"steps\":" + m.group(2) + "}");
                        phase = next;
                        continue;
                    }
                    if (!next.equals(phase)) {
                        phase = next;
                        emit("gen", "{\"id\":" + JSONObject.quote(id) + ",\"phase\":\"" + phase + "\",\"step\":0,\"steps\":0}");
                    }
                }
            }
            int code = p.waitFor();
            if (code != 0 || !out.exists()) {
                String why = code == 137 || code == 9 ? "The phone ran out of memory (close other apps and try again)."
                        : code == 143 || code == 15 ? "cancelled" : "The picture engine stopped (code " + code + ").";
                throw new IllegalStateException(why);
            }
            byte[] png = readAll(out);
            String b64 = Base64.encodeToString(png, Base64.NO_WRAP);
            for (int i = 0; i < b64.length(); i += 262144)
                emit("img", "{\"id\":" + JSONObject.quote(id) + ",\"chunk\":" + JSONObject.quote(b64.substring(i, Math.min(b64.length(), i + 262144))) + "}");
            emit("genend", "{\"id\":" + JSONObject.quote(id) + ",\"ms\":" + (System.currentTimeMillis() - t0) + "}");
        } catch (Exception e) {
            String msg = e.getMessage();
            JSONArray log = new JSONArray();
            for (String s : tail) log.put(s);
            emit("generr", "{\"id\":" + JSONObject.quote(id) + ",\"error\":" + JSONObject.quote(msg == null ? e.getClass().getSimpleName() : msg) + ",\"log\":" + log + "}");
        } finally {
            running = null;
            runningId = null;
            keepScreenOn(false);
            //noinspection ResultOfMethodCallIgnored
            out.delete();
            //noinspection ResultOfMethodCallIgnored
            init.delete();
            //noinspection ResultOfMethodCallIgnored
            mask.delete();
        }
    }

    private void keepScreenOn(boolean on) {
        activity.runOnUiThread(() -> {
            if (on) activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
    }

    private static void write(File f, String dataUrlOrB64) throws java.io.IOException {
        String b64 = dataUrlOrB64.contains(",") ? dataUrlOrB64.substring(dataUrlOrB64.indexOf(',') + 1) : dataUrlOrB64;
        try (FileOutputStream o = new FileOutputStream(f)) { o.write(Base64.decode(b64, Base64.DEFAULT)); }
    }

    private static byte[] readAll(File f) throws java.io.IOException {
        byte[] b = new byte[(int) f.length()];
        try (RandomAccessFile r = new RandomAccessFile(f, "r")) { r.readFully(b); }
        return b;
    }

    private void emit(String kind, String json) {
        final String js = "window.__zig&&window.__zig(" + JSONObject.quote(kind) + "," + json.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029") + ")";
        web.post(() -> web.evaluateJavascript(js, null));
    }
}
