package app.zenvqo.chat;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.Signature;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.zip.CRC32;
import java.util.zip.Deflater;
import java.util.zip.Inflater;

/**
 * Makes an installable Android app from a web page, on the phone, without any build tools.
 *
 * It starts from the bundled template (the :webshell module, an unsigned APK whose activity shows
 * assets/index.html), then:
 *   1. puts the page in as assets/index.html (and the icon in place of the template's PNG),
 *   2. renames the app: the package name and the label are strings in the binary AndroidManifest.xml, whose string
 *      pool is rebuilt with the new values,
 *   3. writes a fresh zip (resources.arsc stored and 4-byte aligned, as Android 11+ requires),
 *   4. signs it with APK Signature Scheme v2 (enough for Android 7.0+, the template's minSdk).
 *
 * Plain Java (no android.* imports) so it can be checked on a computer with apksigner / aapt2.
 */
public final class ApkMaker {
    public static final String TEMPLATE_PACKAGE = "app.zenvqo.webshell.template";
    public static final String TEMPLATE_LABEL = "ZENVQO_WEBAPP_LABEL";

    private ApkMaker() {}

    /** The finished, signed APK. */
    public static byte[] make(byte[] template, byte[] html, String label, String pkg, byte[] iconPng,
                              PrivateKey key, X509Certificate cert) throws Exception {
        if (!validPackage(pkg)) throw new IllegalArgumentException("bad package name: " + pkg);
        List<Entry> entries = readZip(template);
        List<Entry> out = new ArrayList<>();
        boolean hasHtml = false;
        for (Entry e : entries) {
            String n = e.name;
            if (n.startsWith("META-INF/") && (n.endsWith(".SF") || n.endsWith(".RSA") || n.endsWith(".EC") || n.endsWith(".DSA") || n.equals("META-INF/MANIFEST.MF"))) continue;
            if (n.equals("AndroidManifest.xml")) e.data = renameManifest(e.data, pkg, label);
            else if (n.equals("assets/index.html")) { e.data = html; hasHtml = true; }
            else if (iconPng != null && n.startsWith("res/") && n.toLowerCase(Locale.ROOT).endsWith(".png")) e.data = iconPng;
            out.add(e);
        }
        if (!hasHtml) { Entry e = new Entry(); e.name = "assets/index.html"; e.data = html; out.add(e); }
        byte[] unsigned = writeZip(out);
        return signV2(unsigned, key, cert);
    }

    /** "My Notes!" → "app.zenvqo.web.mynotes" style package names (letters, digits, underscores; each part starts with a letter). */
    public static String packageFor(String label, String salt) {
        String slug = label.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]+", "");
        if (slug.isEmpty() || !Character.isLetter(slug.charAt(0))) slug = "app" + slug;
        if (slug.length() > 24) slug = slug.substring(0, 24);
        String s = salt.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]", "");
        return "app.zenvqo.web." + slug + (s.isEmpty() ? "" : "_" + s);
    }

    public static boolean validPackage(String p) {
        return p != null && p.length() <= 200 && p.matches("[a-zA-Z][a-zA-Z0-9_]*(\\.[a-zA-Z][a-zA-Z0-9_]*)+");
    }

    /* ---------------- zip ---------------- */
    static final class Entry { String name; byte[] data; }

    static List<Entry> readZip(byte[] z) throws IOException {
        ByteBuffer b = ByteBuffer.wrap(z).order(ByteOrder.LITTLE_ENDIAN);
        int eocd = findEocd(z);
        int count = b.getShort(eocd + 10) & 0xffff;
        int cd = b.getInt(eocd + 16);
        List<Entry> list = new ArrayList<>();
        int p = cd;
        for (int i = 0; i < count; i++) {
            if (b.getInt(p) != 0x02014b50) throw new IOException("bad central directory");
            int method = b.getShort(p + 10) & 0xffff;
            int csize = b.getInt(p + 20), usize = b.getInt(p + 24);
            int nlen = b.getShort(p + 28) & 0xffff, xlen = b.getShort(p + 30) & 0xffff, clen = b.getShort(p + 32) & 0xffff;
            int local = b.getInt(p + 42);
            String name = new String(z, p + 46, nlen, StandardCharsets.UTF_8);
            p += 46 + nlen + xlen + clen;
            if (name.endsWith("/")) continue;
            int lnlen = b.getShort(local + 26) & 0xffff, lxlen = b.getShort(local + 28) & 0xffff;
            int start = local + 30 + lnlen + lxlen;
            byte[] data;
            if (method == 0) {
                data = new byte[usize];
                System.arraycopy(z, start, data, 0, usize);
            } else if (method == 8) {
                Inflater inf = new Inflater(true);
                inf.setInput(z, start, csize);
                data = new byte[usize];
                try {
                    int got = 0;
                    while (got < usize) {
                        int n = inf.inflate(data, got, usize - got);
                        if (n == 0 && (inf.finished() || inf.needsInput())) break;
                        got += n;
                    }
                    if (got != usize) throw new IOException("short entry " + name);
                } catch (java.util.zip.DataFormatException e) {
                    throw new IOException("bad entry " + name, e);
                } finally { inf.end(); }
            } else throw new IOException("unsupported compression in " + name);
            Entry e = new Entry();
            e.name = name;
            e.data = data;
            list.add(e);
        }
        return list;
    }

    static int findEocd(byte[] z) throws IOException {
        for (int i = z.length - 22; i >= Math.max(0, z.length - 22 - 65535); i--) {
            if (z[i] == 0x50 && z[i + 1] == 0x4b && z[i + 2] == 0x05 && z[i + 3] == 0x06) return i;
        }
        throw new IOException("not a zip file");
    }

    /** resources.arsc (and anything already uncompressible) is stored; its data starts on a 4-byte boundary. */
    static byte[] writeZip(List<Entry> entries) throws IOException {
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        ByteArrayOutputStream cd = new ByteArrayOutputStream();
        int dosTime = 0, dosDate = (2008 - 1980) << 9 | 1 << 5 | 1;          // fixed timestamp: same input, same APK
        // AndroidManifest.xml first is customary
        List<Entry> ordered = new ArrayList<>();
        for (Entry e : entries) if (e.name.equals("AndroidManifest.xml")) ordered.add(e);
        for (Entry e : entries) if (!e.name.equals("AndroidManifest.xml")) ordered.add(e);
        for (Entry e : ordered) {
            byte[] name = e.name.getBytes(StandardCharsets.UTF_8);
            boolean store = e.name.equals("resources.arsc") || e.name.endsWith(".png") || e.name.endsWith(".so");
            byte[] payload = store ? e.data : deflate(e.data);
            if (!store && payload.length >= e.data.length) { store = true; payload = e.data; }
            CRC32 crc = new CRC32();
            crc.update(e.data);
            int offset = body.size();
            int extra = 0;
            if (store) {
                int align = e.name.endsWith(".so") ? 4096 : 4;
                int dataStart = offset + 30 + name.length;
                extra = (align - dataStart % align) % align;
            }
            ByteBuffer h = ByteBuffer.allocate(30).order(ByteOrder.LITTLE_ENDIAN);
            h.putInt(0x04034b50).putShort((short) 20).putShort((short) 0x0800).putShort((short) (store ? 0 : 8))
             .putShort((short) dosTime).putShort((short) dosDate).putInt((int) crc.getValue())
             .putInt(payload.length).putInt(e.data.length).putShort((short) name.length).putShort((short) extra);
            body.write(h.array());
            body.write(name);
            body.write(new byte[extra]);
            body.write(payload);
            ByteBuffer c = ByteBuffer.allocate(46).order(ByteOrder.LITTLE_ENDIAN);
            c.putInt(0x02014b50).putShort((short) 20).putShort((short) 20).putShort((short) 0x0800).putShort((short) (store ? 0 : 8))
             .putShort((short) dosTime).putShort((short) dosDate).putInt((int) crc.getValue())
             .putInt(payload.length).putInt(e.data.length).putShort((short) name.length).putShort((short) 0).putShort((short) 0)
             .putShort((short) 0).putShort((short) 0).putInt(0).putInt(offset);
            cd.write(c.array());
            cd.write(name);
        }
        int cdOffset = body.size();
        byte[] cdBytes = cd.toByteArray();
        ByteBuffer e = ByteBuffer.allocate(22).order(ByteOrder.LITTLE_ENDIAN);
        e.putInt(0x06054b50).putShort((short) 0).putShort((short) 0).putShort((short) ordered.size()).putShort((short) ordered.size())
         .putInt(cdBytes.length).putInt(cdOffset).putShort((short) 0);
        body.write(cdBytes);
        body.write(e.array());
        return body.toByteArray();
    }

    private static byte[] deflate(byte[] in) {
        Deflater d = new Deflater(9, true);
        d.setInput(in);
        d.finish();
        ByteArrayOutputStream o = new ByteArrayOutputStream(Math.max(64, in.length / 2));
        byte[] buf = new byte[16384];
        while (!d.finished()) { int n = d.deflate(buf); o.write(buf, 0, n); }
        d.end();
        return o.toByteArray();
    }

    /* ---------------- binary AndroidManifest.xml ---------------- */
    /** Replaces the template's package name (and anything under it) and label in the manifest's string pool. */
    static byte[] renameManifest(byte[] axml, String pkg, String label) throws IOException {
        ByteBuffer b = ByteBuffer.wrap(axml).order(ByteOrder.LITTLE_ENDIAN);
        if ((b.getShort(0) & 0xffff) != 0x0003) throw new IOException("not a binary XML file");
        int sp = b.getShort(2) & 0xffff;                                   // the string pool follows the file header
        if ((b.getShort(sp) & 0xffff) != 0x0001) throw new IOException("no string pool");
        int hsize = b.getShort(sp + 2) & 0xffff;
        int csize = b.getInt(sp + 4);
        int count = b.getInt(sp + 8), styles = b.getInt(sp + 12), flags = b.getInt(sp + 16);
        int stringsStart = b.getInt(sp + 20), stylesStart = b.getInt(sp + 24);
        boolean utf8 = (flags & 0x100) != 0;
        String[] strings = new String[count];
        for (int i = 0; i < count; i++) {
            int at = sp + stringsStart + b.getInt(sp + hsize + i * 4);
            strings[i] = utf8 ? readUtf8(axml, at) : readUtf16(b, at);
        }
        boolean changed = false;
        for (int i = 0; i < count; i++) {
            String s = strings[i];
            String n = s.equals(TEMPLATE_PACKAGE) ? pkg : s.startsWith(TEMPLATE_PACKAGE + ".") ? pkg + s.substring(TEMPLATE_PACKAGE.length())
                    : s.equals(TEMPLATE_LABEL) ? label : s;
            if (!n.equals(s)) { strings[i] = n; changed = true; }
        }
        if (!changed) throw new IOException("template manifest has no placeholders");
        // rebuild: header, string offsets, style offsets, strings (padded to 4), styles (copied as they are)
        ByteArrayOutputStream data = new ByteArrayOutputStream();
        int[] offs = new int[count];
        for (int i = 0; i < count; i++) {
            offs[i] = data.size();
            data.write(utf8 ? utf8Bytes(strings[i]) : utf16Bytes(strings[i]));
        }
        while (data.size() % 4 != 0) data.write(0);
        byte[] styleOffsets = new byte[styles * 4];
        System.arraycopy(axml, sp + hsize + count * 4, styleOffsets, 0, styleOffsets.length);
        byte[] styleData = new byte[0];
        if (styles > 0) {
            styleData = new byte[sp + csize - (sp + stylesStart)];
            System.arraycopy(axml, sp + stylesStart, styleData, 0, styleData.length);
        }
        int newStringsStart = hsize + count * 4 + styles * 4;
        int newStylesStart = styles > 0 ? newStringsStart + data.size() : 0;
        int newSize = newStringsStart + data.size() + styleData.length;
        ByteBuffer pool = ByteBuffer.allocate(newSize).order(ByteOrder.LITTLE_ENDIAN);
        pool.put(axml, sp, hsize);                                         // copy the header, then fix its fields
        pool.putInt(4, newSize).putInt(20, newStringsStart).putInt(24, newStylesStart);
        pool.position(hsize);
        for (int o : offs) pool.putInt(o);
        pool.put(styleOffsets);
        pool.put(data.toByteArray());
        pool.put(styleData);
        ByteArrayOutputStream out = new ByteArrayOutputStream(axml.length + 256);
        out.write(axml, 0, sp);
        out.write(pool.array());
        out.write(axml, sp + csize, axml.length - (sp + csize));
        byte[] r = out.toByteArray();
        ByteBuffer.wrap(r).order(ByteOrder.LITTLE_ENDIAN).putInt(4, r.length);
        return r;
    }

    private static String readUtf16(ByteBuffer b, int at) {
        int len = b.getShort(at) & 0xffff;
        int p = at + 2;
        if ((len & 0x8000) != 0) { len = ((len & 0x7fff) << 16) | (b.getShort(at + 2) & 0xffff); p += 2; }
        char[] c = new char[len];
        for (int i = 0; i < len; i++) c[i] = (char) (b.getShort(p + i * 2) & 0xffff);
        return new String(c);
    }

    private static String readUtf8(byte[] a, int at) {
        int p = at;
        int chars = a[p++] & 0xff;
        if ((chars & 0x80) != 0) p++;
        int bytes = a[p++] & 0xff;
        if ((bytes & 0x80) != 0) bytes = ((bytes & 0x7f) << 8) | (a[p++] & 0xff);
        return new String(a, p, bytes, StandardCharsets.UTF_8);
    }

    private static byte[] utf16Bytes(String s) {
        int len = s.length();
        ByteBuffer b = ByteBuffer.allocate(4 + len * 2 + 2).order(ByteOrder.LITTLE_ENDIAN);
        if (len > 0x7fff) { b.putShort((short) (0x8000 | (len >> 16))); b.putShort((short) (len & 0xffff)); }
        else b.putShort((short) len);
        for (int i = 0; i < len; i++) b.putShort((short) s.charAt(i));
        b.putShort((short) 0);
        byte[] r = new byte[b.position()];
        System.arraycopy(b.array(), 0, r, 0, r.length);
        return r;
    }

    private static byte[] utf8Bytes(String s) {
        byte[] u = s.getBytes(StandardCharsets.UTF_8);
        ByteArrayOutputStream o = new ByteArrayOutputStream(u.length + 5);
        int chars = s.length();
        if (chars > 0x7f) { o.write(0x80 | (chars >> 8)); o.write(chars & 0xff); } else o.write(chars);
        if (u.length > 0x7f) { o.write(0x80 | (u.length >> 8)); o.write(u.length & 0xff); } else o.write(u.length);
        o.write(u, 0, u.length);
        o.write(0);
        return o.toByteArray();
    }

    /* ---------------- APK Signature Scheme v2 ---------------- */
    private static final int RSA_PKCS1_SHA256 = 0x0103, ECDSA_SHA256 = 0x0201;
    private static final int V2_BLOCK_ID = 0x7109871a;
    private static final int CHUNK = 1 << 20;

    static byte[] signV2(byte[] apk, PrivateKey key, X509Certificate cert) throws Exception {
        int eocd = findEocd(apk);
        ByteBuffer b = ByteBuffer.wrap(apk).order(ByteOrder.LITTLE_ENDIAN);
        int cdOffset = b.getInt(eocd + 16);
        int cdSize = b.getInt(eocd + 12);
        if (cdOffset + cdSize != eocd) throw new IOException("unexpected zip layout");
        // digest of: entries | central directory | end record (its CD offset = where the signing block will start = cdOffset)
        byte[] digest = digest(new byte[][]{ slice(apk, 0, cdOffset), slice(apk, cdOffset, cdSize), slice(apk, eocd, apk.length - eocd) });
        boolean ec = "EC".equalsIgnoreCase(key.getAlgorithm());
        int algo = ec ? ECDSA_SHA256 : RSA_PKCS1_SHA256;

        byte[] digests = lp(lp(concat(u32(algo), lp(digest))));
        byte[] certs = lp(lp(cert.getEncoded()));
        byte[] signedData = concat(digests, certs, lp(new byte[0]));
        Signature sig = Signature.getInstance(ec ? "SHA256withECDSA" : "SHA256withRSA");
        sig.initSign(key);
        sig.update(signedData);
        byte[] signature = sig.sign();
        PublicKey pub = cert.getPublicKey();
        byte[] signer = concat(lp(signedData), lp(lp(concat(u32(algo), lp(signature)))), lp(pub.getEncoded()));
        byte[] v2 = lp(lp(signer));

        // APK Signing Block: size | (pair length, id, value)… | size | magic
        byte[] pair = concat(u64(4 + v2.length), u32(V2_BLOCK_ID), v2);
        long blockSize = pair.length + 8 + 16;
        byte[] block = concat(u64(blockSize), pair, u64(blockSize), "APK Sig Block 42".getBytes(StandardCharsets.US_ASCII));

        ByteArrayOutputStream out = new ByteArrayOutputStream(apk.length + block.length);
        out.write(apk, 0, cdOffset);
        out.write(block);
        out.write(apk, cdOffset, apk.length - cdOffset);
        byte[] r = out.toByteArray();
        ByteBuffer.wrap(r).order(ByteOrder.LITTLE_ENDIAN).putInt(eocd + block.length + 16, cdOffset + block.length);
        return r;
    }

    private static byte[] digest(byte[][] sections) throws Exception {
        List<byte[]> chunks = new ArrayList<>();
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        for (byte[] s : sections) {
            for (int off = 0; off < s.length; off += CHUNK) {
                int len = Math.min(CHUNK, s.length - off);
                md.reset();
                md.update((byte) 0xa5);
                md.update(u32(len));
                md.update(s, off, len);
                chunks.add(md.digest());
            }
        }
        md.reset();
        md.update((byte) 0x5a);
        md.update(u32(chunks.size()));
        for (byte[] c : chunks) md.update(c);
        return md.digest();
    }

    private static byte[] slice(byte[] a, int off, int len) { byte[] r = new byte[len]; System.arraycopy(a, off, r, 0, len); return r; }
    private static byte[] u32(int v) { return ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(v).array(); }
    private static byte[] u64(long v) { return ByteBuffer.allocate(8).order(ByteOrder.LITTLE_ENDIAN).putLong(v).array(); }
    private static byte[] lp(byte[] v) { return concat(u32(v.length), v); }
    private static byte[] concat(byte[]... parts) {
        int n = 0;
        for (byte[] p : parts) n += p.length;
        byte[] r = new byte[n];
        int at = 0;
        for (byte[] p : parts) { System.arraycopy(p, 0, r, at, p.length); at += p.length; }
        return r;
    }

    /** For checks on a computer: java ApkMaker template.apk page.html "Label" pkg keystore.p12 password out.apk [icon.png] */
    public static void main(String[] a) throws Exception {
        java.security.KeyStore ks = java.security.KeyStore.getInstance("PKCS12");
        try (java.io.FileInputStream in = new java.io.FileInputStream(a[4])) { ks.load(in, a[5].toCharArray()); }
        String alias = ks.aliases().nextElement();
        PrivateKey key = (PrivateKey) ks.getKey(alias, a[5].toCharArray());
        X509Certificate cert = (X509Certificate) ks.getCertificate(alias);
        byte[] icon = a.length > 7 ? java.nio.file.Files.readAllBytes(java.nio.file.Paths.get(a[7])) : null;
        byte[] apk = make(java.nio.file.Files.readAllBytes(java.nio.file.Paths.get(a[0])), java.nio.file.Files.readAllBytes(java.nio.file.Paths.get(a[1])),
                a[2], a[3], icon, key, cert);
        java.nio.file.Files.write(java.nio.file.Paths.get(a[6]), apk);
        System.out.println("wrote " + a[6] + " (" + apk.length + " bytes)");
    }
}
