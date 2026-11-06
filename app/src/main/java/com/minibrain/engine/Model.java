package com.minibrain.engine;

import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.ByteOrder;
import java.nio.MappedByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

/**
 * The Transformer from model.py running on the CPU in plain Java.
 * int8 weights (per-row scale), float32 activations, KV cache, multi-threaded mat-vec.
 */
public final class Model implements AutoCloseable {

    /** int8 matrix [rows x cols] with one float scale per row. */
    static final class Q8 {
        final int rows, cols;
        final float[] scale;
        final byte[] q;

        Q8(int rows, int cols, float[] scale, byte[] q) {
            this.rows = rows; this.cols = cols; this.scale = scale; this.q = q;
        }
    }

    static final class Layer {
        float[] norm1, norm2;
        Q8 qkv, proj, w1, w3, w2;
    }

    public final int vocab, blockSize, nLayer, nHead, nEmbd, hidden, headDim;
    final float normEps;
    public final Tokenizer tokenizer;
    public final String systemPrompt;
    final Q8 tokEmb;
    final Layer[] layers;
    final float[] normF;
    final float[][] ropeCos, ropeSin;  // [pos][headDim/2]
    final float[][] kCache, vCache;    // [layer][pos * nEmbd + i]

    // scratch buffers (one forward at a time)
    private final float[] x, h, qkv, att, tmp, a, b, logits, scores;

    private final ExecutorService pool;
    private final int threads;

    private Model(int[] hdr, float ropeBase, float normEps, Tokenizer tok, String sys,
                  Q8 tokEmb, Layer[] layers, float[] normF, int threads) {
        vocab = hdr[0]; blockSize = hdr[1]; nLayer = hdr[2]; nHead = hdr[3]; nEmbd = hdr[4]; hidden = hdr[5];
        headDim = nEmbd / nHead;
        this.normEps = normEps;
        this.tokenizer = tok;
        this.systemPrompt = sys;
        this.tokEmb = tokEmb;
        this.layers = layers;
        this.normF = normF;

        int half = headDim / 2;
        ropeCos = new float[blockSize][half];
        ropeSin = new float[blockSize][half];
        for (int i = 0; i < half; i++) {
            double invFreq = 1.0 / Math.pow(ropeBase, (2.0 * i) / headDim);
            for (int p = 0; p < blockSize; p++) {
                double ang = p * invFreq;
                ropeCos[p][i] = (float) Math.cos(ang);
                ropeSin[p][i] = (float) Math.sin(ang);
            }
        }
        kCache = new float[nLayer][blockSize * nEmbd];
        vCache = new float[nLayer][blockSize * nEmbd];
        x = new float[nEmbd]; h = new float[nEmbd]; qkv = new float[3 * nEmbd];
        att = new float[nEmbd]; tmp = new float[nEmbd];
        a = new float[hidden]; b = new float[hidden];
        logits = new float[vocab];
        scores = new float[nHead * blockSize];
        this.threads = Math.max(1, threads);
        pool = this.threads > 1 ? Executors.newFixedThreadPool(this.threads - 1, r -> {
            Thread t = new Thread(r, "minibrain-worker");
            t.setDaemon(true);
            return t;
        }) : null;
    }

    // ------------------------------------------------------------------ loading
    public static Model load(File file, int threads) throws IOException {
        try (RandomAccessFile raf = new RandomAccessFile(file, "r"); FileChannel ch = raf.getChannel()) {
            MappedByteBuffer buf = ch.map(FileChannel.MapMode.READ_ONLY, 0, ch.size());
            buf.order(ByteOrder.LITTLE_ENDIAN);
            byte[] magic = new byte[4];
            buf.get(magic);
            if (!"MBRN".equals(new String(magic, StandardCharsets.US_ASCII)))
                throw new IOException("Not a MiniBrain model file (make it with export_android.py)");
            int version = buf.getInt();
            if (version != 1) throw new IOException("Unsupported model version " + version);
            int[] hdr = new int[6];
            for (int i = 0; i < 6; i++) hdr[i] = buf.getInt();
            float ropeBase = buf.getFloat(), normEps = buf.getFloat();

            String[] specials = new String[buf.getInt()];
            for (int i = 0; i < specials.length; i++) specials[i] = readString(buf);
            int nMerges = buf.getInt();
            int[] ma = new int[nMerges], mb = new int[nMerges];
            for (int i = 0; i < nMerges; i++) { ma[i] = buf.getInt(); mb[i] = buf.getInt(); }
            String sys = readString(buf);
            Tokenizer tok = new Tokenizer(specials, ma, mb);
            if (tok.vocabSize() != hdr[0])
                throw new IOException("Tokenizer size " + tok.vocabSize() + " != model vocab " + hdr[0]);

            Q8 emb = readQ8(buf);
            Layer[] layers = new Layer[hdr[2]];
            for (int l = 0; l < layers.length; l++) {
                Layer L = new Layer();
                L.norm1 = readVec(buf);
                L.qkv = readQ8(buf);
                L.proj = readQ8(buf);
                L.norm2 = readVec(buf);
                L.w1 = readQ8(buf);
                L.w3 = readQ8(buf);
                L.w2 = readQ8(buf);
                layers[l] = L;
            }
            float[] normF = readVec(buf);
            if (buf.remaining() != 0) throw new IOException("Unexpected data at end of model file");
            return new Model(hdr, ropeBase, normEps, tok, sys.isEmpty() ? null : sys, emb, layers, normF, threads);
        }
    }

    private static String readString(MappedByteBuffer buf) {
        byte[] b = new byte[buf.getInt()];
        buf.get(b);
        return new String(b, StandardCharsets.UTF_8);
    }

    private static float[] readVec(MappedByteBuffer buf) {
        float[] v = new float[buf.getInt()];
        buf.asFloatBuffer().get(v);
        buf.position(buf.position() + 4 * v.length);
        return v;
    }

    private static Q8 readQ8(MappedByteBuffer buf) {
        int rows = buf.getInt(), cols = buf.getInt();
        float[] scale = new float[rows];
        buf.asFloatBuffer().get(scale);
        buf.position(buf.position() + 4 * rows);
        byte[] q = new byte[rows * cols];
        buf.get(q);
        return new Q8(rows, cols, scale, q);
    }

    // ----------------------------------------------------------------- parallel
    private interface Range { void run(int from, int to); }

    private void parallel(int total, Range fn) {
        if (pool == null || total < 64) { fn.run(0, total); return; }
        int chunk = (total + threads - 1) / threads;
        List<Future<?>> futures = new ArrayList<>(threads - 1);
        for (int t = 1; t < threads; t++) {
            final int from = t * chunk, to = Math.min(total, from + chunk);
            if (from >= to) break;
            futures.add(pool.submit(() -> fn.run(from, to)));
        }
        fn.run(0, Math.min(total, chunk));
        try {
            for (Future<?> f : futures) f.get();
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    /** out[r] = scale[r] * sum_c q[r,c] * in[c] */
    private void matvec(Q8 w, float[] in, float[] out) {
        final int cols = w.cols;
        final byte[] q = w.q;
        final float[] sc = w.scale;
        parallel(w.rows, (from, to) -> {
            for (int r = from; r < to; r++) {
                int off = r * cols, c = 0;
                float s0 = 0, s1 = 0, s2 = 0, s3 = 0;
                for (; c + 3 < cols; c += 4) {
                    s0 += q[off + c] * in[c];
                    s1 += q[off + c + 1] * in[c + 1];
                    s2 += q[off + c + 2] * in[c + 2];
                    s3 += q[off + c + 3] * in[c + 3];
                }
                for (; c < cols; c++) s0 += q[off + c] * in[c];
                out[r] = (s0 + s1 + s2 + s3) * sc[r];
            }
        });
    }

    private void rmsnorm(float[] in, float[] w, float[] out) {
        double ss = 0;
        for (float v : in) ss += (double) v * v;
        float inv = (float) (1.0 / Math.sqrt(ss / in.length + normEps));
        for (int i = 0; i < in.length; i++) out[i] = in[i] * inv * w[i];
    }

    private void rope(float[] v, int offset, int pos) {
        float[] cos = ropeCos[pos], sin = ropeSin[pos];
        for (int hd = 0; hd < nHead; hd++) {
            int base = offset + hd * headDim;
            for (int i = 0; i < headDim / 2; i++) {
                float x1 = v[base + 2 * i], x2 = v[base + 2 * i + 1];
                v[base + 2 * i] = x1 * cos[i] - x2 * sin[i];
                v[base + 2 * i + 1] = x1 * sin[i] + x2 * cos[i];
            }
        }
    }

    // ------------------------------------------------------------------ forward
    /** Runs one token at position pos (0-based), using/filling the KV cache. Returns logits (reused buffer). */
    public float[] forward(int token, int pos) {
        if (pos >= blockSize) throw new IllegalArgumentException("position " + pos + " >= context " + blockSize);
        final int C = nEmbd, H = nHead, D = headDim;
        int off = token * C;
        float s = tokEmb.scale[token];
        for (int i = 0; i < C; i++) x[i] = tokEmb.q[off + i] * s;

        final float invSqrtD = (float) (1.0 / Math.sqrt(D));
        for (int l = 0; l < nLayer; l++) {
            Layer L = layers[l];
            rmsnorm(x, L.norm1, h);
            matvec(L.qkv, h, qkv);
            rope(qkv, 0, pos);   // q
            rope(qkv, C, pos);   // k
            final float[] kc = kCache[l], vc = vCache[l];
            System.arraycopy(qkv, C, kc, pos * C, C);
            System.arraycopy(qkv, 2 * C, vc, pos * C, C);

            final int T = pos + 1;
            parallel(H, (h0, h1) -> {
                for (int hh = h0; hh < h1; hh++) {
                    int qo = hh * D, so = hh * blockSize;
                    float max = Float.NEGATIVE_INFINITY;
                    for (int t = 0; t < T; t++) {
                        int ko = t * C + qo;
                        float dot = 0;
                        for (int i = 0; i < D; i++) dot += qkv[qo + i] * kc[ko + i];
                        dot *= invSqrtD;
                        scores[so + t] = dot;
                        if (dot > max) max = dot;
                    }
                    float sum = 0;
                    for (int t = 0; t < T; t++) {
                        float e = (float) Math.exp(scores[so + t] - max);
                        scores[so + t] = e;
                        sum += e;
                    }
                    for (int i = 0; i < D; i++) att[qo + i] = 0;
                    for (int t = 0; t < T; t++) {
                        float p = scores[so + t] / sum;
                        int vo = t * C + qo;
                        for (int i = 0; i < D; i++) att[qo + i] += p * vc[vo + i];
                    }
                }
            });
            matvec(L.proj, att, tmp);
            for (int i = 0; i < C; i++) x[i] += tmp[i];

            rmsnorm(x, L.norm2, h);
            matvec(L.w1, h, a);
            matvec(L.w3, h, b);
            for (int i = 0; i < hidden; i++) {
                float v = a[i];
                a[i] = v / (1f + (float) Math.exp(-v)) * b[i];   // SiLU(w1 x) * (w3 x)
            }
            matvec(L.w2, a, tmp);
            for (int i = 0; i < C; i++) x[i] += tmp[i];
        }
        rmsnorm(x, normF, h);
        matvec(tokEmb, h, logits);   // tied output head
        return logits;
    }

    @Override
    public void close() {
        if (pool != null) pool.shutdownNow();
    }
}
