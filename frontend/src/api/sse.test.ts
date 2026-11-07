import assert from "node:assert/strict";
import { test } from "node:test";
import { createSSEParser, readSSE, type SSEEvent } from "./sse";

test("parses events split across arbitrary chunk boundaries", () => {
  const out: SSEEvent[] = [];
  const p = createSSEParser((e) => out.push(e));
  const text = 'event: meta\ndata: {"a":1}\n\nevent: delta\ndata: {"text":"he"}\n\n: keep-alive\n\nevent: delta\r\ndata: {"text":"llo"}\r\n\r\n';
  for (let i = 0; i < text.length; i += 3) p.feed(text.slice(i, i + 3));
  p.end();
  assert.deepEqual(out.map((e) => e.event), ["meta", "delta", "delta"]);
  assert.equal(JSON.parse(out[2].data).text, "llo");
});

test("multi-line data and default event name", () => {
  const out: SSEEvent[] = [];
  const p = createSSEParser((e) => out.push(e));
  p.feed("data: line1\ndata: line2\n\ndata:no-space\n");
  p.end();
  assert.deepEqual(out, [{ event: "message", data: "line1\nline2" }, { event: "message", data: "no-space" }]);
});

test("readSSE decodes UTF-8 split inside a multi-byte character", async () => {
  const bytes = new TextEncoder().encode('event: delta\ndata: {"text":"नमस्ते"}\n\n');
  const stream = new ReadableStream<Uint8Array>({
    start(ctl) { for (let i = 0; i < bytes.length; i += 5) ctl.enqueue(bytes.slice(i, i + 5)); ctl.close(); },
  });
  const out: SSEEvent[] = [];
  await readSSE(stream, (e) => out.push(e));
  assert.equal(JSON.parse(out[0].data).text, "नमस्ते");
});
