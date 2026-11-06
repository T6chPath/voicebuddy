package com.minibrain.engine;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Byte-level BPE tokenizer: exact port of tokenizer.py. */
public final class Tokenizer {
    // Explicit character sets (identical to Python's re module) instead of \\s / \\d with
    // UNICODE_CHARACTER_CLASS, which Android's regex engine rejects.
    private static final String PUNCT = "!-/:-@\\[-`{-~";
    /** Every character for which Python's str.isspace() is true. */
    private static final String WS = "\\t\\n\\x0B\\f\\r\\x1C-\\x1F \\x85\\xA0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000";
    private static final String DIGIT = "\\p{Nd}";
    private static final Pattern PRETOKENIZE = Pattern.compile(
            "'(?:s|t|re|ve|m|ll|d)"
                    + "| ?[^" + WS + DIGIT + PUNCT + "]+"
                    + "| ?" + DIGIT + "{1,3}"
                    + "| ?[" + PUNCT + "]+"
                    + "|[" + WS + "]+(?![^" + WS + "])"
                    + "|[" + WS + "]+");

    private final byte[][] vocab;              // id -> bytes (null for special tokens)
    private final HashMap<Long, Integer> ranks = new HashMap<>();
    private final String[] specialTokens;
    private final Map<String, Integer> specialIds = new HashMap<>();
    private final Pattern specialPattern;
    private final HashMap<String, int[]> cache = new HashMap<>();
    private final int base;

    public Tokenizer(String[] specialTokens, int[] mergesA, int[] mergesB) {
        int nMerges = mergesA.length;
        this.base = 256 + nMerges;
        this.specialTokens = specialTokens;
        vocab = new byte[base + specialTokens.length][];
        for (int i = 0; i < 256; i++) vocab[i] = new byte[]{(byte) i};
        for (int i = 0; i < nMerges; i++) {
            byte[] a = vocab[mergesA[i]], b = vocab[mergesB[i]];
            byte[] m = new byte[a.length + b.length];
            System.arraycopy(a, 0, m, 0, a.length);
            System.arraycopy(b, 0, m, a.length, b.length);
            vocab[256 + i] = m;
            ranks.put(key(mergesA[i], mergesB[i]), i);
        }
        StringBuilder sp = new StringBuilder();
        for (int i = 0; i < specialTokens.length; i++) {
            specialIds.put(specialTokens[i], base + i);
            if (i > 0) sp.append('|');
            sp.append(Pattern.quote(specialTokens[i]));
        }
        specialPattern = Pattern.compile(sp.toString());
    }

    private static long key(int a, int b) {
        return ((long) a << 32) | (b & 0xffffffffL);
    }

    public int vocabSize() { return vocab.length; }

    public int tokenId(String special) {
        Integer id = specialIds.get(special);
        if (id == null) throw new IllegalArgumentException("unknown special token " + special);
        return id;
    }

    public boolean isSpecial(int id) { return id >= base; }

    public byte[] tokenBytes(int id) { return isSpecial(id) ? new byte[0] : vocab[id]; }

    private int[] encodeChunk(String chunk) {
        int[] cached = cache.get(chunk);
        if (cached != null) return cached;
        byte[] bytes = chunk.getBytes(StandardCharsets.UTF_8);
        int n = bytes.length;
        int[] ids = new int[n];
        for (int i = 0; i < n; i++) ids[i] = bytes[i] & 0xff;
        while (n >= 2) {
            int bestRank = Integer.MAX_VALUE, bestA = -1, bestB = -1;
            for (int i = 0; i + 1 < n; i++) {
                Integer r = ranks.get(key(ids[i], ids[i + 1]));
                if (r != null && r < bestRank) {
                    bestRank = r; bestA = ids[i]; bestB = ids[i + 1];
                }
            }
            if (bestA < 0) break;
            int newId = 256 + bestRank, w = 0;
            for (int i = 0; i < n; ) {
                if (i + 1 < n && ids[i] == bestA && ids[i + 1] == bestB) {
                    ids[w++] = newId; i += 2;
                } else {
                    ids[w++] = ids[i++];
                }
            }
            n = w;
        }
        int[] out = java.util.Arrays.copyOf(ids, n);
        if (cache.size() < 50_000) cache.put(chunk, out);
        return out;
    }

    public void encodeOrdinary(String text, List<Integer> out) {
        Matcher m = PRETOKENIZE.matcher(text);
        while (m.find()) {
            for (int id : encodeChunk(m.group())) out.add(id);
        }
    }

    public List<Integer> encode(String text, boolean allowSpecial) {
        List<Integer> out = new ArrayList<>();
        if (!allowSpecial) {
            encodeOrdinary(text, out);
            return out;
        }
        Matcher m = specialPattern.matcher(text);
        int last = 0;
        while (m.find()) {
            if (m.start() > last) encodeOrdinary(text.substring(last, m.start()), out);
            out.add(specialIds.get(m.group()));
            last = m.end();
        }
        if (last < text.length()) encodeOrdinary(text.substring(last), out);
        return out;
    }

    public String decode(List<Integer> ids, boolean skipSpecial) {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        for (int id : ids) {
            if (isSpecial(id)) {
                if (!skipSpecial) {
                    byte[] b = specialTokens[id - base].getBytes(StandardCharsets.UTF_8);
                    bos.write(b, 0, b.length);
                }
            } else {
                bos.write(vocab[id], 0, vocab[id].length);
            }
        }
        return new String(bos.toByteArray(), StandardCharsets.UTF_8);
    }

    /** Like Python's str.strip() (String.strip() needs Android 13+). */
    static String strip(String s) {
        int a = 0, b = s.length();
        while (a < b && isSpace(s.charAt(a))) a++;
        while (b > a && isSpace(s.charAt(b - 1))) b--;
        return s.substring(a, b);
    }

    private static boolean isSpace(char c) {
        return Character.isWhitespace(c) || Character.isSpaceChar(c) || c == '\u0085';
    }

    // ------------------------------------------------------------ chat format
    /** &lt;|system|&gt;...&lt;|end|&gt;&lt;|user|&gt;...&lt;|end|&gt;&lt;|assistant|&gt; */
    public List<Integer> encodeChat(List<Engine.Message> messages, boolean addGenerationPrompt) {
        List<Integer> ids = new ArrayList<>();
        int end = tokenId("<|end|>");
        for (Engine.Message msg : messages) {
            ids.add(tokenId("<|" + msg.role + "|>"));
            encodeOrdinary(strip(msg.content), ids);
            ids.add(end);
        }
        if (addGenerationPrompt) ids.add(tokenId("<|assistant|>"));
        return ids;
    }
}
