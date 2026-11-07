import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, errorMessage, request, setUnauthorizedHandler, streamChat } from "./client";

test("maps FastAPI error bodies to readable messages", () => {
  assert.equal(errorMessage(400, { detail: "Unknown model." }), "Unknown model.");
  assert.equal(errorMessage(422, { detail: [{ loc: ["body", "email"], msg: "Value error, enter a valid email address" }] }),
    "email: enter a valid email address");
  assert.equal(errorMessage(503, null), "The server had a problem. Please try again.");
  assert.equal(errorMessage(429, {}), "Too many requests — please wait a moment.");
});

test("network failure → ApiError(0); 401 calls the unauthorized handler; CSRF header sent", async () => {
  let sawHeader = "";
  let unauth = 0;
  setUnauthorizedHandler(() => unauth++);
  globalThis.fetch = (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch;
  await assert.rejects(request("GET", "/api/x"), (e: ApiError) => e.isNetwork);
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    sawHeader = (init.headers as Record<string, string>)["X-Requested-With"];
    return new Response(JSON.stringify({ detail: "Please sign in." }), { status: 401 });
  }) as typeof fetch;
  await assert.rejects(request("GET", "/api/x"), (e: ApiError) => e.isAuth && e.message === "Please sign in.");
  assert.equal(unauth, 1);
  assert.equal(sawHeader, "zenvqo");
});

test("streamChat dispatches events and detects truncated streams", async () => {
  const sse = (s: string) => new Response(new Blob([s]).stream(), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  globalThis.fetch = (async () => sse('event: meta\ndata: {"user_message":null,"assistant_message":{"id":"m","model":"x"}}\n\n' +
    'event: delta\ndata: {"text":"Hi"}\n\nevent: done\ndata: {"status":"complete","title":"T"}\n\n')) as typeof fetch;
  let text = "";
  let title: string | null = null;
  await streamChat("/x", {}, { onDelta: (t) => (text += t), onDone: (d) => (title = d.title) }, new AbortController().signal);
  assert.equal(text, "Hi");
  assert.equal(title, "T");
  globalThis.fetch = (async () => sse('event: delta\ndata: {"text":"partial"}\n\n')) as typeof fetch;
  await assert.rejects(streamChat("/x", {}, { onDelta: () => {} }, new AbortController().signal), /ended unexpectedly/);
  globalThis.fetch = (async () => sse('event: error\ndata: {"code":"timeout","message":"Too slow","retryable":true}\n\n')) as typeof fetch;
  let err: ApiError | null = null;
  await streamChat("/x", {}, { onDelta: () => {}, onError: (e) => (err = e) }, new AbortController().signal);
  assert.equal((err as unknown as ApiError).code, "timeout");
});
