/** Reading .zip-based files on the phone (Word, Excel, PowerPoint, OpenDocument, EPUB, plain .zip): the central
 * directory, then each entry stored or deflated. Uses the browser's DecompressionStream when it has one and a small
 * built-in inflater otherwise (older Android WebViews). */

export interface ZipEntry { name: string; size: number; compressed: number; method: number; offset: number }

export class Zip {
  readonly entries: ZipEntry[];
  constructor(private b: Uint8Array) { this.entries = readDirectory(b); }
  has(name: string) { return this.entries.some((e) => e.name === name); }
  find(re: RegExp) { return this.entries.filter((e) => re.test(e.name)); }
  async bytes(name: string | ZipEntry): Promise<Uint8Array | null> {
    const e = typeof name === "string" ? this.entries.find((x) => x.name === name) : name;
    if (!e) return null;
    const v = new DataView(this.b.buffer, this.b.byteOffset, this.b.byteLength);
    if (v.getUint32(e.offset, true) !== 0x04034b50) return null;
    const start = e.offset + 30 + v.getUint16(e.offset + 26, true) + v.getUint16(e.offset + 28, true);
    const data = this.b.subarray(start, start + e.compressed);
    if (e.method === 0) return data;
    if (e.method === 8) return inflateRaw(data, e.size);
    return null;                                               // other compression methods: not readable here
  }
  async text(name: string | ZipEntry): Promise<string | null> {
    const b = await this.bytes(name);
    return b ? new TextDecoder("utf-8").decode(b) : null;
  }
}

export function isZip(b: Uint8Array) { return b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04; }

function readDirectory(b: Uint8Array): ZipEntry[] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file");
  let count = v.getUint16(eocd + 10, true);
  let cd = v.getUint32(eocd + 16, true);
  if (cd === 0xffffffff || count === 0xffff) {                // zip64: find its end-of-directory record
    const loc = eocd - 20;
    if (loc >= 0 && v.getUint32(loc, true) === 0x07064b50) {
      const z64 = Number(v.getBigUint64(loc + 8, true));
      count = Number(v.getBigUint64(z64 + 32, true));
      cd = Number(v.getBigUint64(z64 + 48, true));
    }
  }
  const dec = new TextDecoder("utf-8");
  const out: ZipEntry[] = [];
  let p = cd;
  for (let i = 0; i < count && p + 46 <= b.length; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) break;
    const method = v.getUint16(p + 10, true);
    let compressed = v.getUint32(p + 20, true), size = v.getUint32(p + 24, true);
    const nlen = v.getUint16(p + 28, true), xlen = v.getUint16(p + 30, true), clen = v.getUint16(p + 32, true);
    let offset = v.getUint32(p + 42, true);
    const name = dec.decode(b.subarray(p + 46, p + 46 + nlen));
    // zip64 sizes / offset live in the extra field
    let x = p + 46 + nlen;
    const xend = x + xlen;
    while (x + 4 <= xend) {
      const id = v.getUint16(x, true), len = v.getUint16(x + 2, true);
      if (id === 0x0001) {
        let q = x + 4;
        if (size === 0xffffffff) { size = Number(v.getBigUint64(q, true)); q += 8; }
        if (compressed === 0xffffffff) { compressed = Number(v.getBigUint64(q, true)); q += 8; }
        if (offset === 0xffffffff) { offset = Number(v.getBigUint64(q, true)); }
      }
      x += 4 + len;
    }
    if (!name.endsWith("/")) out.push({ name, size, compressed, method, offset });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

/* ---------------- inflate (RFC 1951) ---------------- */
type DS = { new (format: string): TransformStream<Uint8Array, Uint8Array> };

export async function inflateRaw(data: Uint8Array, expected = 0): Promise<Uint8Array> {
  const D = (globalThis as unknown as { DecompressionStream?: DS }).DecompressionStream;
  if (D) {
    try {
      const stream = new Blob([data]).stream().pipeThrough(new D("deflate-raw"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch { /* fall through to the built-in inflater */ }
  }
  return inflate(data, expected);
}

const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

interface Huff { counts: Uint16Array; symbols: Uint16Array }
function build(lengths: Uint8Array | number[], n: number): Huff {
  const counts = new Uint16Array(16), offs = new Uint16Array(16), symbols = new Uint16Array(n);
  for (let i = 0; i < n; i++) counts[lengths[i]]++;
  counts[0] = 0;
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + counts[i - 1];
  for (let i = 0; i < n; i++) if (lengths[i]) symbols[offs[lengths[i]]++] = i;
  return { counts, symbols };
}

/** A small, dependency-free inflater (canonical Huffman decoding, as in zlib's "puff"). */
export function inflate(src: Uint8Array, expected = 0): Uint8Array {
  let out = new Uint8Array(Math.max(1024, expected || src.length * 4));
  let o = 0, pos = 0, bit = 0, bits = 0;
  const need = (n: number) => { while (bits < n) { if (pos >= src.length) throw new Error("truncated deflate data"); bit |= src[pos++] << bits; bits += 8; } };
  const take = (n: number) => { need(n); const v = bit & ((1 << n) - 1); bit >>>= n; bits -= n; return v; };
  const grow = (n: number) => { if (o + n > out.length) { const b = new Uint8Array(Math.max(out.length * 2, o + n)); b.set(out); out = b; } };
  const decode = (h: Huff) => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= take(1);
      const c = h.counts[len];
      if (code - c < first) return h.symbols[index + (code - first)];
      index += c; first += c; first <<= 1; code <<= 1;
    }
    throw new Error("bad Huffman code");
  };
  const fixedL = (() => { const l = new Uint8Array(288); l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288); return build(l, 288); })();
  const fixedD = build(new Uint8Array(30).fill(5), 30);
  let last = 0;
  do {
    last = take(1);
    const type = take(2);
    if (type === 0) {
      bit = 0; bits = 0;                                        // stored block: skip to a byte boundary
      const len = src[pos] | (src[pos + 1] << 8);
      pos += 4;
      grow(len);
      out.set(src.subarray(pos, pos + len), o);
      o += len; pos += len;
      continue;
    }
    let lit = fixedL, dist = fixedD;
    if (type === 2) {
      const nlen = take(5) + 257, ndist = take(5) + 1, ncode = take(4) + 4;
      const cl = new Uint8Array(19);
      for (let i = 0; i < ncode; i++) cl[CLORDER[i]] = take(3);
      const clh = build(cl, 19);
      const lens = new Uint8Array(nlen + ndist);
      for (let i = 0; i < nlen + ndist;) {
        const sym = decode(clh);
        if (sym < 16) lens[i++] = sym;
        else {
          let rep = 0, val = 0;
          if (sym === 16) { val = lens[i - 1]; rep = 3 + take(2); }
          else if (sym === 17) rep = 3 + take(3);
          else rep = 11 + take(7);
          while (rep--) lens[i++] = val;
        }
      }
      lit = build(lens.subarray(0, nlen), nlen);
      dist = build(lens.subarray(nlen), ndist);
    } else if (type !== 1) throw new Error("bad deflate block");
    for (;;) {
      const sym = decode(lit);
      if (sym < 256) { grow(1); out[o++] = sym; }
      else if (sym === 256) break;
      else {
        const li = sym - 257;
        const len = LBASE[li] + take(LEXT[li]);
        const di = decode(dist);
        const d = DBASE[di] + take(DEXT[di]);
        grow(len);
        for (let k = 0; k < len; k++) { out[o] = out[o - d]; o++; }
      }
    }
  } while (!last);
  return out.subarray(0, o);
}
