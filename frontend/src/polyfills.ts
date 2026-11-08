// Small polyfills for older Android System WebViews (e.g. Chrome 83 on un-updated Android 11 phones). Without
// Array.prototype.at the Markdown renderer crashed on the first reply, so nothing (replies, PDFs) appeared.
/* eslint-disable no-extend-native */
function defineAt(proto: { at?: unknown }) {
  if (typeof proto.at === "function") return;
  Object.defineProperty(proto, "at", {
    configurable: true, writable: true,
    value: function at(this: { length: number; [i: number]: unknown }, n: number) {
      n = Math.trunc(n) || 0;
      if (n < 0) n += this.length;
      return n < 0 || n >= this.length ? undefined : this[n];
    },
  });
}
defineAt(Array.prototype);
defineAt(String.prototype as unknown as { at?: unknown });
if (typeof Int8Array !== "undefined") defineAt(Object.getPrototypeOf(Int8Array.prototype));

if (typeof Object.hasOwn !== "function") {
  Object.defineProperty(Object, "hasOwn", { configurable: true, writable: true,
    value: (o: object, k: PropertyKey) => Object.prototype.hasOwnProperty.call(o, k) });
}

if (typeof String.prototype.replaceAll !== "function") {
  Object.defineProperty(String.prototype, "replaceAll", { configurable: true, writable: true,
    value: function replaceAll(this: string, find: string | RegExp, by: string | ((...a: string[]) => string)) {
      if (find instanceof RegExp) return this.replace(find, by as string);
      return this.split(find).join(typeof by === "string" ? by : by(find));
    } });
}

if (typeof AbortSignal !== "undefined" && typeof (AbortSignal as { timeout?: unknown }).timeout !== "function") {
  (AbortSignal as unknown as { timeout: (ms: number) => AbortSignal }).timeout = (ms: number) => {
    const c = new AbortController();
    setTimeout(() => c.abort(new DOMException("The operation timed out.", "TimeoutError")), ms);
    return c.signal;
  };
}

// ReadableStream async iteration (Chrome 124+): pdf.js reads text and compressed data with `for await`. The same code is
// put in front of the pdf.js worker by scripts/build-standalone.mjs.
const RS = typeof ReadableStream !== "undefined" ? (ReadableStream.prototype as unknown as Record<symbol | string, unknown>) : null;
if (RS && typeof RS[Symbol.asyncIterator] !== "function") {
  RS[Symbol.asyncIterator] = async function* iterate(this: ReadableStream) {
    const reader = this.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  };
  if (typeof RS.values !== "function") RS.values = RS[Symbol.asyncIterator];
}

// ArrayBuffer.prototype.transfer / transferToFixedLength (Chrome 114+): pdf.js moves image data between threads with
// them; without them pages that contain pictures or some fonts came out blank on older WebViews.
const AB = ArrayBuffer.prototype as unknown as Record<string, unknown>;
for (const name of ["transfer", "transferToFixedLength"]) {
  if (typeof AB[name] !== "function") {
    Object.defineProperty(ArrayBuffer.prototype, name, { configurable: true, writable: true,
      value: function transfer(this: ArrayBuffer, length?: number) {
        const n = length === undefined ? this.byteLength : length;
        const out = new ArrayBuffer(n);
        new Uint8Array(out).set(new Uint8Array(this, 0, Math.min(n, this.byteLength)));
        return out;
      } });
  }
}

export {};
