package app.zenvqo.chat;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;

/**
 * "Google Play package": a web page → an Android App Bundle (.aab), the format Google Play takes.
 *
 * It starts from the bundled template bundle (the :webshell module built with `bundleRelease`, unsigned):
 *   1. base/assets/index.html becomes the page, base/res/…/*.png the icon;
 *   2. the manifest (aapt2's protobuf XML) gets the package name, the app name and the version;
 *   3. the bundle is signed like `jarsigner` does (META-INF/MANIFEST.MF, UPLOAD.SF, UPLOAD.RSA) with the
 *      app's upload key. Google Play re-signs the app with its own key (Play App Signing).
 * Upload keys are made here too: RSA 2048, a self-signed certificate valid for 30 years, saved as PKCS#12.
 *
 * Plain Java (no android.* imports) so it can be checked on a computer with bundletool and jarsigner.
 */
public final class PlayBundle {
    private PlayBundle() {}

    public static final String PLACEHOLDER_LABEL = ApkMaker.TEMPLATE_LABEL;

    /** The finished, signed .aab. */
    public static byte[] make(byte[] template, byte[] html, String label, String pkg, byte[] iconPng, int versionCode, String versionName,
                              PrivateKey key, X509Certificate cert) throws Exception {
        if (!ApkMaker.validPackage(pkg)) throw new IllegalArgumentException("bad package name: " + pkg);
        if (versionCode < 1 || versionCode > 2100000000) throw new IllegalArgumentException("bad version code: " + versionCode);
        List<ApkMaker.Entry> out = new ArrayList<>();
        boolean hasHtml = false, hasManifest = false;
        for (ApkMaker.Entry e : ApkMaker.readZip(template)) {
            String n = e.name;
            if (n.startsWith("META-INF/")) continue;                           // old signatures
            if (n.equals("base/manifest/AndroidManifest.xml")) {
                e.data = Manifest.rewrite(e.data, pkg, label, versionCode, versionName);
                hasManifest = true;
            } else if (n.equals("base/assets/index.html")) { e.data = html; hasHtml = true; }
            else if (iconPng != null && n.startsWith("base/res/") && n.toLowerCase(Locale.ROOT).endsWith(".png")) e.data = iconPng;
            out.add(e);
        }
        if (!hasManifest) throw new IOException("The app template is not an Android App Bundle.");
        if (!hasHtml) { ApkMaker.Entry e = new ApkMaker.Entry(); e.name = "base/assets/index.html"; e.data = html; out.add(e); }
        List<ApkMaker.Entry> signed = new ArrayList<>(JarSigner.sign(out, key, cert, "UPLOAD"));   // META-INF first, as jar readers expect
        signed.addAll(out);
        return ApkMaker.writeZip(signed);
    }

    // ------------------------------------------------------------------ manifest (aapt2 Resources.proto XmlNode)

    /** Just enough protobuf to rewrite a few attributes of the manifest and leave everything else byte-for-byte. */
    static final class Proto {
        final int field, wire; final long num; final byte[] bytes;
        Proto(int field, int wire, long num, byte[] bytes) { this.field = field; this.wire = wire; this.num = num; this.bytes = bytes; }

        static List<Proto> parse(byte[] b) throws IOException {
            List<Proto> r = new ArrayList<>();
            int[] p = {0};
            while (p[0] < b.length) {
                long tag = varint(b, p);
                int f = (int) (tag >>> 3), w = (int) (tag & 7);
                switch (w) {
                    case 0: r.add(new Proto(f, w, varint(b, p), null)); break;
                    case 1: r.add(new Proto(f, w, 0, slice(b, p, 8))); break;
                    case 2: { int len = (int) varint(b, p); r.add(new Proto(f, w, 0, slice(b, p, len))); break; }
                    case 5: r.add(new Proto(f, w, 0, slice(b, p, 4))); break;
                    default: throw new IOException("unsupported protobuf wire type " + w);
                }
            }
            return r;
        }

        static byte[] write(List<Proto> fields) {
            ByteArrayOutputStream o = new ByteArrayOutputStream();
            for (Proto x : fields) {
                putVarint(o, ((long) x.field << 3) | x.wire);
                if (x.wire == 0) putVarint(o, x.num);
                else if (x.wire == 2) { putVarint(o, x.bytes.length); o.write(x.bytes, 0, x.bytes.length); }
                else o.write(x.bytes, 0, x.bytes.length);
            }
            return o.toByteArray();
        }

        static Proto str(int field, String s) { return new Proto(field, 2, 0, s.getBytes(StandardCharsets.UTF_8)); }
        static Proto msg(int field, List<Proto> m) { return new Proto(field, 2, 0, write(m)); }
        String text() { return new String(bytes, StandardCharsets.UTF_8); }

        private static long varint(byte[] b, int[] p) throws IOException {
            long v = 0;
            for (int shift = 0; shift < 64; shift += 7) {
                if (p[0] >= b.length) throw new IOException("truncated protobuf");
                int c = b[p[0]++] & 0xff;
                v |= (long) (c & 0x7f) << shift;
                if ((c & 0x80) == 0) return v;
            }
            throw new IOException("bad varint");
        }
        private static byte[] slice(byte[] b, int[] p, int len) throws IOException {
            if (len < 0 || p[0] + len > b.length) throw new IOException("truncated protobuf");
            byte[] r = new byte[len];
            System.arraycopy(b, p[0], r, 0, len);
            p[0] += len;
            return r;
        }
        private static void putVarint(ByteArrayOutputStream o, long v) {
            while ((v & ~0x7fL) != 0) { o.write((int) ((v & 0x7f) | 0x80)); v >>>= 7; }
            o.write((int) v);
        }
    }

    /**
     * XmlNode { element = 1 (XmlElement), text = 2 }
     * XmlElement { namespace_declaration = 1, namespace_uri = 2, name = 3, attribute = 4 (XmlAttribute), child = 5 (XmlNode) }
     * XmlAttribute { namespace_uri = 1, name = 2, value = 3, source = 4, resource_id = 5, compiled_item = 6 (Item) }
     * Item { ref = 1, str = 2 (String { value = 1 }), raw_str = 3, styled_str = 4, file = 5, id = 6, prim = 7 (Primitive) }
     */
    static final class Manifest {
        static byte[] rewrite(byte[] node, String pkg, String label, int versionCode, String versionName) throws IOException {
            int[] seen = new int[4];                                          // package, versionCode, versionName, labels
            byte[] r = node(node, pkg, label, versionCode, versionName, seen);
            if (seen[0] == 0) throw new IOException("the template manifest has no package name");
            if (seen[3] == 0) throw new IOException("the template manifest has no app name placeholder");
            return r;
        }

        private static byte[] node(byte[] b, String pkg, String label, int vc, String vn, int[] seen) throws IOException {
            List<Proto> f = Proto.parse(b);
            for (int i = 0; i < f.size(); i++)
                if (f.get(i).field == 1 && f.get(i).wire == 2) f.set(i, new Proto(1, 2, 0, element(f.get(i).bytes, pkg, label, vc, vn, seen)));
            return Proto.write(f);
        }

        private static byte[] element(byte[] b, String pkg, String label, int vc, String vn, int[] seen) throws IOException {
            List<Proto> f = Proto.parse(b);
            String name = "";
            for (Proto x : f) if (x.field == 3 && x.wire == 2) name = x.text();
            boolean manifest = name.equals("manifest");
            for (int i = 0; i < f.size(); i++) {
                Proto x = f.get(i);
                if (x.field == 4 && x.wire == 2) f.set(i, new Proto(4, 2, 0, attribute(x.bytes, manifest, pkg, label, vc, vn, seen)));
                else if (x.field == 5 && x.wire == 2) f.set(i, new Proto(5, 2, 0, node(x.bytes, pkg, label, vc, vn, seen)));
            }
            return Proto.write(f);
        }

        private static byte[] attribute(byte[] b, boolean manifest, String pkg, String label, int vc, String vn, int[] seen) throws IOException {
            List<Proto> f = Proto.parse(b);
            String name = "", value = null;
            for (Proto x : f) {
                if (x.field == 2 && x.wire == 2) name = x.text();
                if (x.field == 3 && x.wire == 2) value = x.text();
            }
            String newValue = null;
            Long newNumber = null;
            if (manifest && name.equals("package")) { newValue = pkg; seen[0]++; }
            else if (manifest && name.equals("versionCode")) { newValue = Integer.toString(vc); newNumber = (long) vc; seen[1]++; }
            else if (manifest && name.equals("versionName")) { newValue = vn; seen[2]++; }
            else if (PLACEHOLDER_LABEL.equals(value)) { newValue = label; seen[3]++; }
            if (newValue == null) return b;
            List<Proto> out = new ArrayList<>();
            boolean wroteValue = false;
            for (Proto x : f) {
                if (x.field == 3 && x.wire == 2) { out.add(Proto.str(3, newValue)); wroteValue = true; }
                else if (x.field == 6 && x.wire == 2) out.add(new Proto(6, 2, 0, item(x.bytes, newValue, newNumber)));
                else out.add(x);
            }
            if (!wroteValue) out.add(Proto.str(3, newValue));
            return Proto.write(out);
        }

        /** a compiled value: a string (Item.str.value) or a number (Item.prim.<int field>) */
        private static byte[] item(byte[] b, String text, Long number) throws IOException {
            List<Proto> f = Proto.parse(b);
            for (int i = 0; i < f.size(); i++) {
                Proto x = f.get(i);
                if (x.field == 2 && x.wire == 2) {                             // String { value = 1 }
                    List<Proto> s = new ArrayList<>();
                    for (Proto y : Proto.parse(x.bytes)) s.add(y.field == 1 ? Proto.str(1, text) : y);
                    f.set(i, Proto.msg(2, s));
                } else if (x.field == 7 && x.wire == 2 && number != null) {    // Primitive { int_decimal_value = 6 | … }
                    List<Proto> p = new ArrayList<>();
                    for (Proto y : Proto.parse(x.bytes)) p.add(y.wire == 0 ? new Proto(y.field, 0, number, null) : y);
                    f.set(i, Proto.msg(7, p));
                }
            }
            return Proto.write(f);
        }
    }

    // ------------------------------------------------------------------ JAR signing (what jarsigner does)

    static final class JarSigner {
        static List<ApkMaker.Entry> sign(List<ApkMaker.Entry> entries, PrivateKey key, X509Certificate cert, String alias) throws Exception {
            MessageDigest sha = MessageDigest.getInstance("SHA-256");
            String main = "Manifest-Version: 1.0\r\nCreated-By: zenvqo\r\n\r\n";
            StringBuilder mf = new StringBuilder(main);
            StringBuilder sfSections = new StringBuilder();
            for (ApkMaker.Entry e : entries) {
                if (e.name.endsWith("/")) continue;                            // folders aren't signed
                String section = wrap("Name: " + e.name) + "SHA-256-Digest: " + b64(sha.digest(e.data)) + "\r\n\r\n";
                mf.append(section);
                sfSections.append(wrap("Name: " + e.name))
                          .append("SHA-256-Digest: ").append(b64(sha.digest(section.getBytes(StandardCharsets.UTF_8)))).append("\r\n\r\n");
            }
            byte[] manifest = mf.toString().getBytes(StandardCharsets.UTF_8);
            String sf = "Signature-Version: 1.0\r\nCreated-By: zenvqo\r\n"
                    + "SHA-256-Digest-Manifest: " + b64(sha.digest(manifest)) + "\r\n"
                    + "SHA-256-Digest-Manifest-Main-Attributes: " + b64(sha.digest(main.getBytes(StandardCharsets.UTF_8))) + "\r\n\r\n"
                    + sfSections;
            byte[] sfBytes = sf.getBytes(StandardCharsets.UTF_8);
            Signature s = Signature.getInstance("SHA256withRSA");
            s.initSign(key);
            s.update(sfBytes);
            byte[] block = Der.pkcs7(cert, s.sign());
            List<ApkMaker.Entry> r = new ArrayList<>();
            r.add(entry("META-INF/MANIFEST.MF", manifest));
            r.add(entry("META-INF/" + alias + ".SF", sfBytes));
            r.add(entry("META-INF/" + alias + ".RSA", block));
            return r;
        }

        /** manifest lines are at most 72 bytes; longer ones continue on the next line after one space */
        static String wrap(String line) {
            byte[] b = line.getBytes(StandardCharsets.UTF_8);
            if (b.length <= 72) return line + "\r\n";
            StringBuilder out = new StringBuilder();
            int i = 0, first = 72;
            while (i < b.length) {
                int n = Math.min(first, b.length - i);
                while (n > 1 && i + n < b.length && (b[i + n] & 0xC0) == 0x80) n--;   // don't split a UTF-8 character
                if (i > 0) out.append(' ');
                out.append(new String(b, i, n, StandardCharsets.UTF_8)).append("\r\n");
                i += n;
                first = 71;
            }
            return out.toString();
        }

        private static ApkMaker.Entry entry(String name, byte[] data) { ApkMaker.Entry e = new ApkMaker.Entry(); e.name = name; e.data = data; return e; }
    }

    // ------------------------------------------------------------------ DER: PKCS#7 signature block and certificates

    static final class Der {
        static final byte[] SHA256 = oid(2, 16, 840, 1, 101, 3, 4, 2, 1);
        static final byte[] RSA = oid(1, 2, 840, 113549, 1, 1, 1);
        static final byte[] SHA256_RSA = oid(1, 2, 840, 113549, 1, 1, 11);
        static final byte[] DATA = oid(1, 2, 840, 113549, 1, 7, 1);
        static final byte[] SIGNED_DATA = oid(1, 2, 840, 113549, 1, 7, 2);
        static final byte[] CN = oid(2, 5, 4, 3), O = oid(2, 5, 4, 10);
        static final byte[] NULL = {0x05, 0x00};

        /** SignedData with the certificate and one signer, no signed attributes (like apksigner's v1 blocks). */
        static byte[] pkcs7(X509Certificate cert, byte[] signature) throws Exception {
            byte[] issuerAndSerial = seq(cert.getIssuerX500Principal().getEncoded(), integer(cert.getSerialNumber()));
            byte[] signer = seq(integer(BigInteger.ONE), issuerAndSerial, seq(SHA256, NULL), seq(RSA, NULL), tlv(0x04, signature));
            byte[] signedData = seq(integer(BigInteger.ONE), set(seq(SHA256, NULL)), seq(DATA),
                    tlv(0xA0, cert.getEncoded()), set(signer));
            return seq(SIGNED_DATA, tlv(0xA0, signedData));
        }

        /** A self-signed X.509 v3 certificate for an upload key. */
        static X509Certificate selfSigned(KeyPair kp, String commonName, int years) throws Exception {
            byte[] name = seq(set(seq(CN, tlv(0x0C, commonName.getBytes(StandardCharsets.UTF_8)))),
                              set(seq(O, tlv(0x0C, "zenvqo".getBytes(StandardCharsets.UTF_8)))));
            long now = System.currentTimeMillis() - 60_000L;
            Date from = new Date(now), to = new Date(now + years * 365L * 24 * 3600 * 1000);
            byte[] serial = integer(new BigInteger(63, new SecureRandom()).add(BigInteger.ONE));
            byte[] tbs = seq(tlv(0xA0, integer(BigInteger.valueOf(2))), serial, seq(SHA256_RSA, NULL), name,
                    seq(time(from), time(to)), name, kp.getPublic().getEncoded());
            Signature s = Signature.getInstance("SHA256withRSA");
            s.initSign(kp.getPrivate());
            s.update(tbs);
            byte[] sig = s.sign();
            byte[] bits = new byte[sig.length + 1];
            System.arraycopy(sig, 0, bits, 1, sig.length);
            byte[] der = seq(tbs, seq(SHA256_RSA, NULL), tlv(0x03, bits));
            return (X509Certificate) CertificateFactory.getInstance("X.509").generateCertificate(new java.io.ByteArrayInputStream(der));
        }

        private static byte[] time(Date d) {                                  // UTCTime before 2050, GeneralizedTime after
            SimpleDateFormat utc = new SimpleDateFormat("yyMMddHHmmss'Z'", Locale.ROOT), gen = new SimpleDateFormat("yyyyMMddHHmmss'Z'", Locale.ROOT);
            utc.setTimeZone(TimeZone.getTimeZone("UTC"));
            gen.setTimeZone(TimeZone.getTimeZone("UTC"));
            java.util.Calendar c = java.util.Calendar.getInstance(TimeZone.getTimeZone("UTC"));
            c.setTime(d);
            return c.get(java.util.Calendar.YEAR) < 2050 ? tlv(0x17, utc.format(d).getBytes(StandardCharsets.US_ASCII))
                                                         : tlv(0x18, gen.format(d).getBytes(StandardCharsets.US_ASCII));
        }

        static byte[] oid(long... parts) {
            ByteArrayOutputStream o = new ByteArrayOutputStream();
            o.write((int) (parts[0] * 40 + parts[1]));
            for (int i = 2; i < parts.length; i++) {
                long v = parts[i];
                byte[] tmp = new byte[10];
                int n = 0;
                tmp[n++] = (byte) (v & 0x7f);
                while ((v >>>= 7) != 0) tmp[n++] = (byte) ((v & 0x7f) | 0x80);
                for (int j = n - 1; j >= 0; j--) o.write(tmp[j]);
            }
            return tlv(0x06, o.toByteArray());
        }
        static byte[] integer(BigInteger v) { return tlv(0x02, v.toByteArray()); }
        static byte[] seq(byte[]... parts) { return tlv(0x30, cat(parts)); }
        static byte[] set(byte[]... parts) { return tlv(0x31, cat(parts)); }
        static byte[] tlv(int tag, byte[] v) {
            ByteArrayOutputStream o = new ByteArrayOutputStream();
            o.write(tag);
            int n = v.length;
            if (n < 0x80) o.write(n);
            else if (n < 0x100) { o.write(0x81); o.write(n); }
            else if (n < 0x10000) { o.write(0x82); o.write(n >> 8); o.write(n); }
            else if (n < 0x1000000) { o.write(0x83); o.write(n >> 16); o.write(n >> 8); o.write(n); }
            else { o.write(0x84); o.write(n >>> 24); o.write(n >> 16); o.write(n >> 8); o.write(n); }
            o.write(v, 0, v.length);
            return o.toByteArray();
        }
        private static byte[] cat(byte[]... parts) {
            ByteArrayOutputStream o = new ByteArrayOutputStream();
            for (byte[] p : parts) o.write(p, 0, p.length);
            return o.toByteArray();
        }
    }

    // ------------------------------------------------------------------ upload keys

    /** A new upload key, saved as a PKCS#12 keystore (alias "upload") that keytool, jarsigner and Android Studio can open. */
    public static byte[] newUploadKeystore(String appName, char[] password) throws Exception {
        KeyPairGenerator g = KeyPairGenerator.getInstance("RSA");
        g.initialize(2048, new SecureRandom());
        KeyPair kp = g.generateKeyPair();
        X509Certificate cert = Der.selfSigned(kp, appName.isEmpty() ? "Upload key" : appName + " upload key", 30);
        KeyStore ks = KeyStore.getInstance("PKCS12");
        ks.load(null, null);
        ks.setKeyEntry("upload", kp.getPrivate(), password, new Certificate[]{cert});
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        ks.store(o, password);
        return o.toByteArray();
    }

    public static KeyStore loadKeystore(byte[] p12, char[] password) throws Exception {
        KeyStore ks = KeyStore.getInstance("PKCS12");
        ks.load(new java.io.ByteArrayInputStream(p12), password);
        return ks;
    }

    /** The upload certificate as PEM (Play Console asks for it if the upload key ever has to be reset). */
    public static String pem(X509Certificate cert) throws Exception {
        String b = b64(cert.getEncoded());
        StringBuilder s = new StringBuilder("-----BEGIN CERTIFICATE-----\n");
        for (int i = 0; i < b.length(); i += 64) s.append(b, i, Math.min(b.length(), i + 64)).append('\n');
        return s.append("-----END CERTIFICATE-----\n").toString();
    }

    /** Base64 (java.util.Base64 needs Android 8; this runs on 7 too). */
    static String b64(byte[] d) {
        final String A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        StringBuilder s = new StringBuilder((d.length + 2) / 3 * 4);
        for (int i = 0; i < d.length; i += 3) {
            int n = (d[i] & 0xff) << 16 | (i + 1 < d.length ? (d[i + 1] & 0xff) << 8 : 0) | (i + 2 < d.length ? d[i + 2] & 0xff : 0);
            s.append(A.charAt(n >> 18 & 63)).append(A.charAt(n >> 12 & 63))
             .append(i + 1 < d.length ? A.charAt(n >> 6 & 63) : '=').append(i + 2 < d.length ? A.charAt(n & 63) : '=');
        }
        return s.toString();
    }

    /** SHA-1 / SHA-256 fingerprints as AA:BB:… (shown in Play Console under App integrity). */
    public static String fingerprint(X509Certificate cert, String algo) throws Exception {
        byte[] d = MessageDigest.getInstance(algo).digest(cert.getEncoded());
        StringBuilder s = new StringBuilder();
        for (byte x : d) { if (s.length() > 0) s.append(':'); s.append(String.format(Locale.ROOT, "%02X", x)); }
        return s.toString();
    }

    /** For checks on a computer: java PlayBundle template.aab page.html "Label" pkg versionCode versionName out.aab key.p12 password [icon.png]
     *  (key.p12 is made if it doesn't exist) */
    public static void main(String[] a) throws Exception {
        java.nio.file.Path keyFile = java.nio.file.Paths.get(a[7]);
        char[] pw = a[8].toCharArray();
        if (!java.nio.file.Files.exists(keyFile)) java.nio.file.Files.write(keyFile, newUploadKeystore(a[2], pw));
        KeyStore ks = loadKeystore(java.nio.file.Files.readAllBytes(keyFile), pw);
        PrivateKey key = (PrivateKey) ks.getKey("upload", pw);
        X509Certificate cert = (X509Certificate) ks.getCertificate("upload");
        byte[] icon = a.length > 9 ? java.nio.file.Files.readAllBytes(java.nio.file.Paths.get(a[9])) : null;
        byte[] aab = make(java.nio.file.Files.readAllBytes(java.nio.file.Paths.get(a[0])), java.nio.file.Files.readAllBytes(java.nio.file.Paths.get(a[1])),
                a[2], a[3], icon, Integer.parseInt(a[4]), a[5], key, cert);
        java.nio.file.Files.write(java.nio.file.Paths.get(a[6]), aab);
        System.out.println("wrote " + a[6] + " (" + aab.length + " bytes), upload key SHA-256 " + fingerprint(cert, "SHA-256"));
    }
}
