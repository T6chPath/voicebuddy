/** Incremental Server-Sent Events parser (fetch + ReadableStream; EventSource can't POST). */
export interface SSEEvent { event: string; data: string }

export function createSSEParser(onEvent: (e: SSEEvent) => void) {
  let buf = "";
  let event = "message";
  let data: string[] = [];
  const flush = () => {
    if (data.length) onEvent({ event, data: data.join("\n") });
    event = "message";
    data = [];
  };
  return {
    feed(chunk: string) {
      buf += chunk;
      let nl: number;
      while ((nl = buf.search(/\r\n|\r|\n/)) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + (buf.startsWith("\r\n", nl) ? 2 : 1));
        if (line === "") flush();
        else if (line.startsWith(":")) continue;                  // comment / keep-alive
        else {
          const i = line.indexOf(":");
          const field = i < 0 ? line : line.slice(0, i);
          const value = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
          if (field === "event") event = value;
          else if (field === "data") data.push(value);
        }
      }
    },
    end() { if (buf) { this.feed("\n"); } flush(); },
  };
}

export async function readSSE(body: ReadableStream<Uint8Array>, onEvent: (e: SSEEvent) => void): Promise<void> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  const p = createSSEParser(onEvent);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    p.feed(dec.decode(value, { stream: true }));
  }
  p.feed(dec.decode());
  p.end();
}
