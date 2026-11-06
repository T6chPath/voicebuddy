package com.minibrain.engine;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Random;
import java.util.Set;

/** High-level chat API around {@link Model}: prompt building, KV-cache reuse, sampling, streaming. */
public final class Engine implements AutoCloseable {

    public static final class Message {
        public final String role, content;   // role: system | user | assistant
        public Message(String role, String content) { this.role = role; this.content = content; }
    }

    public static final class GenConfig {
        public int maxNewTokens = 256;
        public float temperature = 0.7f;
        public int topK = 50;
        public float topP = 0.9f;
        public float repetitionPenalty = 1.1f;
        public long seed = -1;
    }

    public interface Listener { void onText(String piece); }

    public final Model model;
    private final Tokenizer tok;
    private final List<Integer> ctx = new ArrayList<>();  // tokens currently in the KV cache
    private float[] lastLogits;
    private volatile boolean cancelled;
    private final int endId, eotId, userId;

    private Engine(Model model) {
        this.model = model;
        this.tok = model.tokenizer;
        endId = tok.tokenId("<|end|>");
        eotId = tok.tokenId("<|endoftext|>");
        userId = tok.tokenId("<|user|>");
    }

    public static Engine load(File file, int threads) throws IOException {
        return new Engine(Model.load(file, threads));
    }

    public String info() {
        long params = (long) model.vocab * model.nEmbd
                + (long) model.nLayer * (4L * model.nEmbd * model.nEmbd + 3L * model.nEmbd * model.hidden);
        return String.format(java.util.Locale.US, "%.0fM params, context %d", params / 1e6, model.blockSize);
    }

    public void cancel() { cancelled = true; }

    /** Clears the KV cache (e.g. on "New chat"). */
    public synchronized void reset() { ctx.clear(); lastLogits = null; }

    // --------------------------------------------------------------- prompting
    List<Integer> promptIds(List<Message> messages, int maxNew) {
        int budget = model.blockSize - Math.min(maxNew, model.blockSize / 2);
        List<Message> msgs = new ArrayList<>(messages);
        if (model.systemPrompt != null && (msgs.isEmpty() || !"system".equals(msgs.get(0).role)))
            msgs.add(0, new Message("system", model.systemPrompt));
        List<Integer> ids;
        while (true) {
            ids = tok.encodeChat(msgs, true);
            if (ids.size() <= budget || msgs.size() <= 1) break;
            msgs.remove("system".equals(msgs.get(0).role) ? 1 : 0);  // forget oldest turn
        }
        return ids.size() > budget ? new ArrayList<>(ids.subList(ids.size() - budget, ids.size())) : ids;
    }

    /** Feeds prompt tokens, reusing whatever prefix is already in the KV cache. */
    private void prefill(List<Integer> ids) {
        int common = 0;
        int max = Math.min(ctx.size(), ids.size());
        while (common < max && ctx.get(common).equals(ids.get(common))) common++;
        if (common == ids.size()) common--;           // must run at least one token to get logits
        while (ctx.size() > common) ctx.remove(ctx.size() - 1);
        for (int i = common; i < ids.size(); i++) {
            if (cancelled) return;
            lastLogits = model.forward(ids.get(i), i);
            ctx.add(ids.get(i));
        }
    }

    // --------------------------------------------------------------- generation
    /** Generates the assistant's reply. Blocks; calls listener with text pieces as they arrive. */
    public synchronized String chat(List<Message> messages, GenConfig cfg, Listener listener) {
        cancelled = false;
        Random rng = cfg.seed >= 0 ? new Random(cfg.seed) : new Random();
        prefill(promptIds(messages, cfg.maxNewTokens));
        Utf8Stream dec = new Utf8Stream();
        StringBuilder reply = new StringBuilder();
        for (int n = 0; n < cfg.maxNewTokens && !cancelled; n++) {
            int next = sample(lastLogits, cfg, rng);
            if (next == endId || next == eotId || next == userId) break;
            String piece = tok.isSpecial(next) ? "" : dec.feed(tok.tokenBytes(next));
            if (!piece.isEmpty()) {
                reply.append(piece);
                if (listener != null) listener.onText(piece);
            }
            if (ctx.size() >= model.blockSize) break;  // context full
            lastLogits = model.forward(next, ctx.size());
            ctx.add(next);
        }
        String tail = dec.flush();
        if (!tail.isEmpty()) {
            reply.append(tail);
            if (listener != null) listener.onText(tail);
        }
        return reply.toString().trim();
    }

    /** Plain text continuation (for a model that is not chat-tuned). */
    public synchronized String complete(String prompt, GenConfig cfg, Listener listener) {
        cancelled = false;
        Random rng = cfg.seed >= 0 ? new Random(cfg.seed) : new Random();
        List<Integer> ids = tok.encode(prompt, false);
        if (ids.isEmpty()) ids.add(eotId);
        int keep = model.blockSize / 2;
        if (ids.size() > keep) ids = new ArrayList<>(ids.subList(ids.size() - keep, ids.size()));
        prefill(ids);
        Utf8Stream dec = new Utf8Stream();
        StringBuilder out = new StringBuilder();
        for (int n = 0; n < cfg.maxNewTokens && !cancelled; n++) {
            int next = sample(lastLogits, cfg, rng);
            if (next == eotId || next == endId) break;
            String piece = tok.isSpecial(next) ? "" : dec.feed(tok.tokenBytes(next));
            out.append(piece);
            if (listener != null && !piece.isEmpty()) listener.onText(piece);
            if (ctx.size() >= model.blockSize) break;
            lastLogits = model.forward(next, ctx.size());
            ctx.add(next);
        }
        out.append(dec.flush());
        return out.toString();
    }

    // ------------------------------------------------------------------ sampler
    int sample(float[] logitsIn, GenConfig cfg, Random rng) {
        final int V = logitsIn.length;
        float[] logits = logitsIn.clone();
        if (cfg.repetitionPenalty > 0 && cfg.repetitionPenalty != 1f) {
            Set<Integer> seen = new HashSet<>(ctx.subList(Math.max(0, ctx.size() - 128), ctx.size()));
            for (int id : seen) {
                float v = logits[id];
                logits[id] = v > 0 ? v / cfg.repetitionPenalty : v * cfg.repetitionPenalty;
            }
        }
        if (cfg.temperature <= 0) {
            int best = 0;
            for (int i = 1; i < V; i++) if (logits[i] > logits[best]) best = i;
            return best;
        }
        // keep the top-k candidates, sorted descending (insertion into a small array)
        int k = cfg.topK > 0 ? Math.min(cfg.topK, V) : Math.min(256, V);
        int[] idx = new int[k];
        float[] val = new float[k];
        int filled = 0;
        for (int i = 0; i < V; i++) {
            float v = logits[i];
            if (filled == k && v <= val[k - 1]) continue;
            int j = filled < k ? filled++ : k - 1;
            while (j > 0 && val[j - 1] < v) { val[j] = val[j - 1]; idx[j] = idx[j - 1]; j--; }
            val[j] = v; idx[j] = i;
        }
        double[] p = new double[filled];
        double sum = 0;
        for (int i = 0; i < filled; i++) {
            p[i] = Math.exp((val[i] - val[0]) / cfg.temperature);
            sum += p[i];
        }
        // nucleus (top-p): keep tokens while the probability mass *before* them is <= topP
        int cut = filled;
        if (cfg.topP > 0 && cfg.topP < 1) {
            double cum = 0;
            for (int i = 0; i < filled; i++) {
                if (cum > cfg.topP) { cut = i; break; }
                cum += p[i] / sum;
            }
        }
        double total = 0;
        for (int i = 0; i < cut; i++) total += p[i];
        double r = rng.nextDouble() * total;
        for (int i = 0; i < cut; i++) {
            r -= p[i];
            if (r <= 0) return idx[i];
        }
        return idx[cut - 1];
    }

    @Override
    public void close() { model.close(); }

    /** Converts a stream of UTF-8 byte chunks to text without splitting characters. */
    static final class Utf8Stream {
        private final ByteArrayOutputStream pending = new ByteArrayOutputStream();

        String feed(byte[] bytes) {
            pending.write(bytes, 0, bytes.length);
            byte[] all = pending.toByteArray();
            int complete = completePrefix(all);
            pending.reset();
            pending.write(all, complete, all.length - complete);
            return complete == 0 ? "" : new String(all, 0, complete, StandardCharsets.UTF_8);
        }

        String flush() {
            byte[] all = pending.toByteArray();
            pending.reset();
            return new String(all, StandardCharsets.UTF_8);
        }

        /** Length of the prefix that does not end in an unfinished multi-byte character. */
        private static int completePrefix(byte[] b) {
            int n = b.length;
            for (int back = 1; back <= Math.min(3, n); back++) {
                int c = b[n - back] & 0xff;
                if ((c & 0xC0) == 0x80) continue;            // continuation byte, keep looking back
                int need = c >= 0xF0 ? 4 : c >= 0xE0 ? 3 : c >= 0xC0 ? 2 : 1;
                return need > back ? n - back : n;
            }
            return n;
        }
    }
}
