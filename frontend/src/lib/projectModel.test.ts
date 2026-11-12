import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelInfo } from "../api/types";
import { bestProjectModel, isProjectRequest } from "./projectModel";

const list = (...ids: string[]): ModelInfo[] => ids.map((id) => ({ id: "srv:" + id, label: id, vision: !/oss|deepseek|nemotron-3-ultra/.test(id), description: "" }));
const pick = (models: ModelInfo[], current: string, vision = false) => bestProjectModel(models, "srv:" + current, vision)?.id.replace(/^srv:/, "") ?? null;

test("Google Gemini: the newest Flash — a free key can't use the 3.x Pro, and a Pro the user chose stays", () => {
  const g = list("gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro", "gemini-3.8-flash", "gemini-3.8-flash-lite", "gemini-3.1-pro-preview",
    "gemini-3.8-live", "gemini-3.9-flash-preview");
  assert.equal(pick(g, "gemini-2.5-flash"), "gemini-3.8-flash");
  assert.equal(pick(g, "gemini-2.5-flash-lite"), "gemini-3.8-flash");
  assert.equal(pick(g, "gemini-2.5-pro"), "gemini-3.8-flash");                 // an older Pro: the newest Flash codes better
  assert.equal(pick(g, "gemini-3.8-flash"), null);                             // already the best: nothing changes
  assert.equal(pick(g, "gemini-3.1-pro-preview"), null);                       // a paid key's Pro stays
});

test("Claude, OpenAI, DeepSeek, Mistral: the strongest coder of each", () => {
  const c = list("claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-opus-4-5-20251101");
  assert.equal(pick(c, "claude-haiku-5-5"), "claude-opus-5-5");
  assert.equal(pick(c, "claude-opus-4-5-20251101"), "claude-opus-5-5");        // the same family, newer
  assert.equal(pick(list("claude-haiku-5-5", "claude-sonnet-5-5"), "claude-haiku-5-5"), "claude-sonnet-5-5");
  assert.equal(pick(list("claude-sonnet-5-5", "claude-fable-5-1"), "claude-fable-5-1"), null);   // the top tier stays when chosen
  const o = list("gpt-4.1", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.4", "gpt-5.4-2026-03-05", "gpt-5.4-pro", "gpt-5.3-codex", "gpt-5.4-chat-latest", "o3");
  assert.equal(pick(o, "gpt-5.4-mini"), "gpt-5.4");                            // not Pro (costly), not Codex (another API)
  assert.equal(pick(o, "gpt-5.4-pro"), null);
  assert.equal(pick(list("deepseek-flash", "deepseek-v4-pro", "deepseek-reasoner"), "deepseek-flash"), "deepseek-v4-pro");
  const m = list("mistral-small-latest", "mistral-medium-latest", "mistral-large-latest", "codestral-latest", "devstral-small-2507", "devstral-2512");
  assert.equal(pick(m, "mistral-small-latest"), "devstral-2512");
  assert.equal(pick(m, "codestral-latest"), null);                             // a coding model the user chose stays
});

test("Groq and OpenRouter: a free key stays on free models", () => {
  const groq = list("llama-3.1-8b-instant", "openai/gpt-oss-20b", "openai/gpt-oss-120b", "qwen/qwen3-32b", "openai/gpt-oss-safeguard-20b", "groq/compound");
  assert.equal(pick(groq, "llama-3.1-8b-instant"), "openai/gpt-oss-120b");
  assert.equal(pick(groq, "openai/gpt-oss-20b"), "openai/gpt-oss-120b");
  assert.equal(pick(groq, "openai/gpt-oss-120b"), null);
  const or = list("openrouter/free", "nvidia/nemotron-3-ultra:free", "nvidia/nemotron-3.5-super-vl:free", "openai/gpt-oss-120b:free",
    "google/gemma-4-31b-it:free", "cohere/north-mini-code:free", "anthropic/claude-opus-5.5", "anthropic/claude-sonnet-5.5", "google/gemini-3.8-flash");
  assert.equal(pick(or, "openrouter/free"), "nvidia/nemotron-3-ultra:free");
  assert.equal(pick(or, "google/gemma-4-31b-it:free"), "nvidia/nemotron-3-ultra:free");
  assert.equal(pick(or, "google/gemini-3.8-flash"), "anthropic/claude-opus-5.5");     // paid in use: paid models allowed
  assert.equal(pick(or, "openrouter/free", true), "nvidia/nemotron-3.5-super-vl:free"); // a picture attached: a model that sees
});

test("a picture model, the demo, an unknown model", () => {
  const g = [...list("gemini-2.5-flash", "gemini-3.8-flash"), { id: "srv:gemini-3.1-flash-image", label: "Nano Banana 2", vision: false, description: "", pictures: true },
    { id: "img:free", label: "Picture AI — free", vision: false, description: "", pictures: true }, { id: "echo", label: "Offline demo", vision: false, description: "" }];
  assert.equal(bestProjectModel(g, "srv:gemini-3.1-flash-image")?.id, "srv:gemini-3.8-flash");   // pictures can't write code
  assert.equal(bestProjectModel(g, "img:free")?.id, "srv:gemini-3.8-flash");
  assert.equal(bestProjectModel(g, "echo")?.id, "srv:gemini-3.8-flash");
  assert.equal(bestProjectModel(g.slice(3), "echo"), null);                     // the offline demo alone: nothing to switch to
  assert.equal(pick(list("zenvqo-3b-q4_k_m.gguf"), "zenvqo-3b-q4_k_m.gguf"), null);          // one model on a laptop
  assert.equal(pick(list("my-big-model", "openai/gpt-oss-120b"), "my-big-model"), null);       // an unknown model the user chose stays
  assert.equal(pick(list("llama3.1:8b", "qwen3-coder:30b"), "llama3.1:8b"), "qwen3-coder:30b"); // a small one is replaced
});

test("project requests: apps, websites, games, programs — not questions, writing, PDFs or pictures", () => {
  for (const t of ["Make an app: a calculator", "Make a website for a small bakery", "Make a to-do list app that remembers my tasks",
    "build a snake game in html", "make me a full stack e-commerce web app with login", "write a python program for library management",
    "mujhe ek website bana do", "write the complete code for a chat app", "make a large project", "create a flutter app for expense tracking",
    "can you make a tic tac toe game?", "make a chrome extension that blocks ads", "develop a discord bot"]) assert.ok(isProjectRequest(t), t);
  for (const t of ["Explain photosynthesis simply, with a diagram", "Show a table comparing Python and JavaScript", "how do I build a website?",
    "Make a 10-question quiz on the solar system as a PDF", "write an essay about historical sites in India", "make a list of websites for learning coding",
    "make a game plan for my exams", "Teach me as a book: web development", "make a project on pollution for class 8", "design a logo for my app",
    "make an app icon", "Create an image of a website design", "Write a short story about a robot who loves chai"]) assert.ok(!isProjectRequest(t), t);
});
