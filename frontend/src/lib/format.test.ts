import assert from "node:assert/strict";
import { test } from "node:test";
import type { Conversation } from "../api/types";
import { fileSize, groupConversations } from "./format";
import { parse } from "./router";

const c = (id: string, daysAgo: number, pinned = false): Conversation =>
  ({ id, title: id, model: "m", pinned, created_at: 0, updated_at: (Date.UTC(2026, 10, 7, 12) - daysAgo * 86400_000) / 1000 });

test("groups conversations by recency with pinned first", () => {
  const now = Date.UTC(2026, 10, 7, 12);
  const g = groupConversations([c("a", 0), c("b", 1), c("c", 3), c("d", 20), c("e", 90), c("p", 50, true)], now);
  assert.deepEqual(g.map((x) => [x.label, x.items.map((i) => i.id)]), [
    ["Pinned", ["p"]], ["Today", ["a"]], ["Yesterday", ["b"]], ["Previous 7 days", ["c"]], ["Previous 30 days", ["d"]], ["Older", ["e"]],
  ]);
});

test("file sizes", () => {
  assert.equal(fileSize(512), "512 B");
  assert.equal(fileSize(2048), "2.0 KB");
  assert.equal(fileSize(5 * 1024 * 1024), "5.0 MB");
});

test("routes", () => {
  assert.deepEqual(parse("/c/cnv_abc123"), { conversationId: "cnv_abc123" });
  assert.deepEqual(parse("/"), { conversationId: null });
  assert.deepEqual(parse("/c/../../x"), { conversationId: null });
});
