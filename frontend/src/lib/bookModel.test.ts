import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelInfo } from "../api/types";
import { bestBookModel, bookSpeed, modelName } from "./bookModel";

const list = (...ids: string[]): ModelInfo[] => ids.map((id) => ({ id: "srv:" + id, label: id, vision: true, description: "" }));
const pick = (models: ModelInfo[], current = models[0]?.id || "") => bestBookModel(models, current)?.id.replace(/^srv:/, "") ?? null;

test("Google Gemini: the newest Flash — not Lite, Live, speech or a preview", () => {
  const g = list("gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-3.5-flash", "gemini-3.8-flash", "gemini-3.5-flash-lite",
    "gemini-3.1-pro-preview", "gemini-3.8-live", "gemini-3-flash-preview", "gemini-3.7-flash");
  assert.equal(pick(g, "srv:gemini-2.5-flash"), "gemini-3.8-flash");
  assert.equal(pick(list("gemini-2.5-flash", "gemini-2.5-pro")), "gemini-2.5-flash");
});

test("Groq, OpenAI, Claude, DeepSeek, Mistral", () => {
  assert.equal(pick(list("openai/gpt-oss-20b", "openai/gpt-oss-120b", "qwen/qwen3.6-27b", "whisper-large-v3")), "openai/gpt-oss-120b");
  assert.equal(pick(list("gpt-4.1", "gpt-4.1-mini", "gpt-5-mini", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.4")), "gpt-5.4-mini");
  assert.equal(pick(list("claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5-20251001", "claude-haiku-5-5")), "claude-haiku-5-5");
  assert.equal(pick(list("deepseek-v4-pro", "deepseek-v4-flash", "deepseek-flash")), "deepseek-flash");
  assert.equal(pick(list("deepseek-chat", "deepseek-reasoner")), "deepseek-chat");
  assert.equal(pick(list("mistral-large-latest", "codestral-latest", "mistral-small-latest", "mistral-medium-latest")), "mistral-medium-latest");
});

test("OpenRouter: a free key stays on free models; a paid model in use allows paid ones", () => {
  const or = list("openrouter/free", "nvidia/nemotron-3.5-lightning:free", "nvidia/nemotron-3-ultra:free", "google/gemma-4-31b-it:free",
    "google/gemini-3.8-flash", "deepseek/deepseek-flash");
  assert.equal(pick(or, "srv:openrouter/free"), "nvidia/nemotron-3-ultra:free");
  assert.equal(pick(or, "srv:deepseek/deepseek-flash"), "google/gemini-3.8-flash");
  assert.equal(pick(list("openrouter/free", "some/new-model:free"), "srv:openrouter/free"), "openrouter/free");
});

test("nothing better to choose: one model on a laptop, the offline demo", () => {
  assert.equal(pick(list("zenvqo-3b-q4_k_m.gguf")), null);
  assert.equal(bestBookModel([{ id: "echo", label: "Offline demo", vision: false, description: "" }], "echo"), null);
  assert.equal(bestBookModel([], ""), null);
});

test("model names for people", () => {
  assert.equal(modelName("srv:gemini-3.8-flash"), "Gemini 3.8 Flash");
  assert.equal(modelName("srv:openai/gpt-oss-120b"), "GPT-OSS 120B");
  assert.equal(modelName("srv:gpt-5.4-mini"), "GPT-5.4 Mini");
  assert.equal(modelName("srv:claude-haiku-5-5"), "Claude Haiku 5.5");
  assert.equal(modelName("srv:deepseek-flash"), "DeepSeek Flash");
  assert.equal(modelName("srv:mistral-medium-latest"), "Mistral Medium");
  assert.equal(modelName("srv:nvidia/nemotron-3-ultra:free"), "Nemotron 3 Ultra");
  assert.equal(modelName("srv:google/gemma-4-31b-it:free"), "Gemma 4 31B");
  assert.equal(modelName("srv:openrouter/free"), "OpenRouter free models");
});

test("book pages start sooner where the service takes a thinking setting", () => {
  assert.deepEqual(bookSpeed("https://generativelanguage.googleapis.com/v1beta/openai", "gemini-3.8-flash"), { reasoning_effort: "low" });
  assert.deepEqual(bookSpeed("https://api.groq.com/openai/v1", "openai/gpt-oss-120b"), { reasoning_effort: "low" });
  assert.deepEqual(bookSpeed("https://api.openai.com/v1", "gpt-5.4-mini"), { reasoning_effort: "low" });
  assert.deepEqual(bookSpeed("https://openrouter.ai/api/v1", "nvidia/nemotron-3-ultra:free"), { reasoning: { effort: "low" } });
  assert.equal(bookSpeed("https://api.openai.com/v1", "gpt-4.1-mini"), undefined);            // doesn't think: nothing to set
  assert.equal(bookSpeed("https://api.anthropic.com/v1", "claude-haiku-5-5"), undefined);
  assert.equal(bookSpeed("http://192.168.1.20:8080", "my-model.gguf"), undefined);
});
