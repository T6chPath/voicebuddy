import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, fileUrl, LOCAL_MODE, regenerate as apiRegenerate, regenerateMessage as apiRegenerateMessage, sendMessage, type StreamHandlers,
  uploadFile } from "../api/client";
import type { Attachment, Conversation, ImageCaps, ImageOptions, Message, UploadedFile } from "../api/types";
import { useSession } from "../state/session";
import { useToasts } from "../state/toasts";
import { Composer, type ComposerHandle } from "./Composer";
import { Icon } from "./Icon";
import { Eye } from "./Brand";
import { MakeAppDialog } from "./MakeAppDialog";
import { SitePreview } from "./SitePreview";
import { BookBar } from "./BookViews";
import { bookReplyIds, findBook, isBookRequest, type Book } from "../lib/book";
import { bestBookModel, modelName } from "../lib/bookModel";
import { bestProjectModel, isProjectRequest } from "../lib/projectModel";
import { PlayDialog, type PlayTarget } from "./PlayDialog";
import { listenForShares, takeShared } from "../share/incoming";
import { FilePreview, type PreviewTarget } from "./FilePreview";
import { APK_REQUEST } from "../apk/apk";

type IconName = string;
import { changedOpts, DEFAULT_IMAGE_OPTS, type ImageAction, ImageSettings, Lightbox, MaskEditor } from "./ImageViews";
import { MessageView } from "./MessageView";
import { AutoSpeakToggle } from "./SpeechViews";
import { speech } from "../speech/player";
import { loadServerVoices } from "../speech/setup";
import { voice } from "../voice/session";
import { MicIndicator, VoicePanel } from "./VoiceViews";
import { canSaveFile, wantsPdf } from "../pdf/pdf";
import { pdfStore } from "../pdf/store";

interface Props {
  conversationId: string | null;
  navigate: (to: string, replace?: boolean) => void;
  onConversationChange: (c: Partial<Conversation> & { id: string }, created?: boolean) => void;
  onOpenSidebar: () => void;
  sidebarOpen: boolean;
}

/** Home-screen ideas: three are picked at random each time, so the page feels fresh. */
const IDEAS = [
  "Explain photosynthesis simply, with a diagram",
  "Draft a polite email asking my manager for leave",
  "Show a table comparing Python and JavaScript",
  "Make a 10-question quiz on the solar system as a PDF",
  "Plan a 3-day trip to Jaipur on a student budget",
  "Make a to-do list app that remembers my tasks",
  "Write a short story about a robot who loves chai",
  "Explain compound interest with a worked example",
  "Make a website for a small bakery",
  "Help me prepare for a job interview",
];
type Tool = { key: string; icon: IconName; label: string; tone: string; run: "camera" | "files" | string };
/** One-tap shortcuts to what zenvqo does best; text ones start the request in the message box. */
const TOOLS: Tool[] = [
  { key: "snap", icon: "camera", label: "Snap a question", tone: "blue", run: "camera" },
  { key: "image", icon: "image", label: "Create an image", tone: "violet", run: "Create an image of " },
  { key: "app", icon: "phone", label: "Build an app", tone: "green", run: "Make an app: " },
  { key: "pdf", icon: "pdf", label: "Make a PDF", tone: "red", run: "Make a PDF of notes on " },
  { key: "graph", icon: "graph", label: "Plot a graph", tone: "teal", run: "Plot y = " },
  { key: "file", icon: "clip", label: "Read a file", tone: "amber", run: "files" },
];
function greeting(d = new Date()): string {
  const h = d.getHours();
  return h >= 5 && h < 12 ? "Good morning" : h >= 12 && h < 17 ? "Good afternoon" : h >= 17 && h < 22 ? "Good evening" : "Hello";
}

export function ChatView({ conversationId, navigate, onConversationChange, onOpenSidebar, sidebarOpen }: Props) {
  const { settings, models } = useSession();
  const toasts = useToasts();
  const [messages, setMessages] = useState<Message[]>([]);
  const [title, setTitle] = useState("New chat");
  const [model, setModel] = useState<string>(settings.default_model || models[0]?.id || "");
  const [loadState, setLoadState] = useState<"idle" | "loading" | "error" | "missing">("idle");
  const [busy, setBusy] = useState(false);
  const [announce, setAnnounce] = useState("");
  const [atBottom, setAtBottom] = useState(true);
  const abort = useRef<AbortController | null>(null);
  const justCreated = useRef<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const composer = useRef<ComposerHandle>(null);
  const pendingText = useRef("");
  const raf = useRef(0);
  const [caps, setCaps] = useState<ImageCaps | null>(null);
  const [imageOpts, setImageOpts] = useState<ImageOptions>({ ...DEFAULT_IMAGE_OPTS });
  const [showImageSettings, setShowImageSettings] = useState(false);
  const [target, setTarget] = useState<Attachment | null>(null);
  const [viewing, setViewing] = useState<Attachment | null>(null);
  const [masking, setMasking] = useState<Attachment | null>(null);
  const [makeApp, setMakeApp] = useState<string | null>(null);
  const [site, setSite] = useState<string | null>(null);
  // a book ("Teach me as a book: …") is written with the best fast, accurate model on the user's AI service
  const bestBook = useMemo(() => bestBookModel(models, model), [models, model]);
  // a project (an app, a website, a game…) is written with the strongest coding model — unless the user picked the model
  const userPicked = useRef(false);
  const lastStreaming = messages[messages.length - 1]?.status === "streaming";
  const askedFor = useMemo(() => {                                     // each reply's question, in one pass
    let q: string | undefined;
    return messages.map((m) => { const r = m.role === "assistant" ? q : undefined; if (m.role === "user") q = m.content; return r; });
  }, [messages]);
  const rewriting = messages.some((m, i) => i < messages.length - 1 && m.status === "streaming");   // an earlier page written again
  const lastBook = useRef<Book | null>(null);
  const book = useMemo(() => {
    if (lastStreaming) return null;
    if (rewriting) return lastBook.current;                            // the bar stays as it was until the page is done
    return (lastBook.current = findBook(messages));
  }, [messages, lastStreaming, rewriting]);
  const bookPages = useMemo(() => bookReplyIds(messages), [messages]);
  const [ideas] = useState(() => [...IDEAS].sort(() => Math.random() - 0.5).slice(0, 3));
  const [play, setPlay] = useState<PlayTarget | null>(null);          // "Google Play package"              // "View site": the page shown full-screen         // "Make app": the page to turn into an APK
  // shared from WhatsApp, Gallery, Files… (Android share menu): into the message box of a new chat, like ChatGPT
  const convRef = useRef(conversationId);
  convRef.current = conversationId;
  const applyShared = () => {
    const q = takeShared();
    if (!q) return;
    if (q.files.length) composer.current?.addFiles(q.files);
    if (q.text) composer.current?.setText(q.text);
    composer.current?.focus();
  };
  useEffect(() => listenForShares(() => { if (convRef.current) navigate("/"); else applyShared(); }), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!conversationId) applyShared(); }, [conversationId]); // eslint-disable-line react-hooks/exhaustive-deps
  const [preview, setPreview] = useState<PreviewTarget | null>(null);   // a sent file, opened
  const [dropping, setDropping] = useState(false);                     // files dragged over the chat
  const dragDepth = useRef(0);
  useEffect(() => {
    const on = (e: Event) => setPreview((e as CustomEvent<PreviewTarget>).detail);
    window.addEventListener("zc-preview-file", on);
    return () => window.removeEventListener("zc-preview-file", on);
  }, []);
  useEffect(() => {
    const on = (e: Event) => { const h = (e as CustomEvent<{ html: string }>).detail?.html; if (h) setMakeApp(h); };
    window.addEventListener("zc-make-app", on);
    return () => window.removeEventListener("zc-make-app", on);
  }, []);
  useEffect(() => {
    const on = (e: Event) => { const h = (e as CustomEvent<{ html: string }>).detail?.html; if (h) setSite(h); };
    window.addEventListener("zc-view-site", on);
    return () => window.removeEventListener("zc-view-site", on);
  }, []);
  useEffect(() => {
    const on = (e: Event) => { const d = (e as CustomEvent<PlayTarget>).detail; if (d) setPlay(d); };
    window.addEventListener("zc-play", on);
    return () => window.removeEventListener("zc-play", on);
  }, []);
  const imagesOn = !!caps?.available;
  const liveReplies = useRef(new Set<string>());          // replies streamed in this session (auto-speak only these)

  // auto-speak / voice mode: read each new reply sentence by sentence while it streams
  useEffect(() => {
    const m = messages[messages.length - 1];
    if (!m || m.role !== "assistant" || !liveReplies.current.has(m.id)) return;
    const voiceOn = voice.state.phase !== "off" && voice.state.phase !== "error";
    if (!speech.settings.autoSpeak && !voiceOn) return;
    if (m.status === "error" || m.status === "stopped") { if (voiceOn) voice.replyFinished(); return; }
    if (m.content && voiceOn) voice.replyToken();
    speech.feed(m.id, m.content, m.status !== "streaming");
    if (m.status !== "streaming" && voiceOn) voice.replyFinished();
  }, [messages]);
  // "make a PDF of …": when that reply is complete, turn it into a PDF (Android app: saved straight to Downloads;
  // browsers: a card with "Save PDF", which opens the print window — browsers only allow that after a tap)
  useEffect(() => {
    const m = messages[messages.length - 1];
    if (!m || m.role !== "assistant" || m.status !== "complete" || !m.content || !liveReplies.current.has(m.id) || pdfStore.get(m.id)) return;
    const req = [...messages].reverse().find((x) => x.role === "user")?.content || "";
    if (!wantsPdf(req)) return;
    if (canSaveFile()) void pdfStore.make(m.id, m.content, req);
    else pdfStore.offer(m.id, m.content, req);
  }, [messages]);
  const busyRef = useRef(false);
  busyRef.current = busy;
  useEffect(() => () => voice.end(), []);
  useEffect(() => () => speech.stop(), [conversationId]);
  useEffect(() => { void loadServerVoices(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented && speech.state.status !== "idle" && !document.querySelector("dialog[open]")) speech.stop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    let live = true;
    api.imageCaps().then((c) => live && setCaps(c)).catch(() => live && setCaps(null));
    return () => { live = false; };
  }, [settings.server_url, settings.api_key]);                // the phone app's engines follow Settings → Connection
  useEffect(() => { setTarget(null); setMasking(null); setViewing(null); }, [conversationId]);

  // picture numbers (#1, #2…) — only recounted when the pictures change, not on every word of a streaming reply
  const imageIds = messages.map((m) => m.attachments.filter((a) => a.kind === "image").map((a) => a.id).join(",")).join("|");
  const numbers = useMemo(() => {
    const map = new Map<string, number>();
    for (const id of imageIds.split(/[|,]/)) if (id && !map.has(id)) map.set(id, map.size + 1);
    return map;
  }, [imageIds]);
  const numberOf = useCallback((id: string) => numbers.get(id), [numbers]);

  // ----- load conversation -----
  const load = useCallback((id: string) => {
    const ctl = new AbortController();
    setLoadState("loading");
    api.conversation(id, ctl.signal)
      .then((c) => { setMessages(c.messages); setTitle(c.title); setModel(c.model); setLoadState("idle"); })
      .catch((e) => {
        if ((e as Error).name === "AbortError") return;
        setLoadState(e instanceof ApiError && e.status === 404 ? "missing" : "error");
      });
    return ctl;
  }, []);

  useEffect(() => {
    // first message of a new chat changes the URL while its reply is streaming: keep that stream alive
    if (conversationId && justCreated.current === conversationId) { justCreated.current = null; return; }
    abort.current?.abort();
    userPicked.current = false;
    if (!conversationId) {
      setMessages([]); setTitle("New chat"); setLoadState("idle");
      setModel(settings.default_model || models[0]?.id || "");
      composer.current?.focus();
      return;
    }
    const ctl = load(conversationId);
    return () => ctl.abort();
  }, [conversationId, load]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (!conversationId && settings.default_model) setModel(settings.default_model); }, [settings.default_model, conversationId]);

  // ----- scrolling: follow the stream only if the user is already at the bottom -----
  const onScroll = () => {
    const el = scroller.current;
    if (el) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  };
  // follow the reply as it grows — when the page has been laid out anyway (a ResizeObserver), instead of forcing a
  // fresh layout of the whole conversation after every update (that was most of the lag on long replies)
  // the reply being written: the last one — or a book page being written again in its place (then the view stays on that
  // page instead of following the end of the conversation)
  const streamTarget = useRef<string | null>(null);
  const atBottomRef = useRef(atBottom);
  atBottomRef.current = atBottom;
  useLayoutEffect(() => { if (atBottom && !streamTarget.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [atBottom]);
  useEffect(() => {
    const el = scroller.current, inner = el?.firstElementChild;
    if (!el || !inner || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => { if (atBottomRef.current && !streamTarget.current) el.scrollTop = el.scrollHeight; });
    ro.observe(inner);
    return () => ro.disconnect();
  }, []);
  const regenerateRef = useRef<() => void>(() => {});
  const regeneratePageRef = useRef<(id: string) => void>(() => {});
  const onRegeneratePage = useCallback((id: string) => regeneratePageRef.current(id), []);
  const imageActionRef = useRef<(action: ImageAction, a: Attachment) => void>(() => {});
  const onRegenerate = useCallback(() => regenerateRef.current(), []);
  const onImageAction = useCallback((action: ImageAction, a: Attachment) => imageActionRef.current(action, a), []);
  const messageFileHref = useCallback((a: Attachment, d?: boolean) => fileUrl(a.id, d) || null, []);
  const jumpToLatest = () => scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });

  // ----- streaming helpers -----
  const patchLast = (fn: (m: Message) => Message) =>
    setMessages((ms) => {
      const t = streamTarget.current;
      if (t) { const i = ms.findIndex((m) => m.id === t); return i < 0 ? ms : [...ms.slice(0, i), fn(ms[i]), ...ms.slice(i + 1)]; }
      return ms.length && ms[ms.length - 1].role === "assistant" ? [...ms.slice(0, -1), fn(ms[ms.length - 1])] : ms;
    });

  const flushDeltas = () => {
    raf.current = 0;
    const chunk = pendingText.current;
    pendingText.current = "";
    if (chunk) patchLast((m) => ({ ...m, content: m.content + chunk }));
  };

  function handlers(cid: string, onMetaUser?: (m: Message) => void): StreamHandlers {
    return {
      onMeta: (d) => {
        if (d.user_message) onMetaUser?.(d.user_message);
        liveReplies.current.add(d.assistant_message.id);
        patchLast((m) => ({ ...m, id: d.assistant_message.id, model: d.assistant_message.model }));
      },
      onDelta: (t) => {                                 // batch tokens per animation frame: smooth even on slow phones
        pendingText.current += t;
        if (!raf.current) raf.current = requestAnimationFrame(flushDeltas);
      },
      onDone: (d) => {
        flushDeltas();
        patchLast((m) => ({ ...m, status: "complete" }));
        if (d.title) { setTitle(d.title); onConversationChange({ id: cid, title: d.title, updated_at: Date.now() / 1000 }); }
        else onConversationChange({ id: cid, updated_at: Date.now() / 1000 });
        setAnnounce("Response complete.");
      },
      onError: (e) => {
        flushDeltas();
        patchLast((m) => ({ ...m, status: "error", error: e.message, tool: m.tool && { ...m.tool, status: "failed" } }));
        setAnnounce("The response failed: " + e.message);
      },
      onTool: (t) => {
        patchLast((m) => ({ ...m, tool: { name: t.name, op: t.op || m.tool?.op || "generate", status: t.status,
          fraction: t.status === "done" ? 1 : m.tool?.fraction || 0, text: m.tool?.text || "" } }));
        if (t.status === "running") setAnnounce("Working on the image…");
      },
      onProgress: (p) => patchLast((m) => (m.tool ? { ...m, tool: { ...m.tool, fraction: p.fraction, text: p.text } } : m)),
      onImage: (a) => {
        patchLast((m) => ({ ...m, attachments: [...m.attachments, a] }));
        setAnnounce("Image ready.");
      },
    };
  }

  async function runStream(start: (signal: AbortSignal) => Promise<void>) {
    const ctl = new AbortController();
    abort.current = ctl;
    setBusy(true);
    setAnnounce("Assistant is responding…");
    try {
      await start(ctl.signal);
      if (ctl.signal.aborted) {
        flushDeltas();
        patchLast((m) => ({ ...m, status: "stopped" }));
        setAnnounce("Response stopped.");
      }
    } catch (e) {
      flushDeltas();
      const msg = e instanceof ApiError ? e.message : "Something went wrong.";
      patchLast((m) => ({ ...m, status: "error", error: msg }));
      setAnnounce("The response failed: " + msg);
      throw e;
    } finally {
      setBusy(false);
      abort.current = null;
      composer.current?.focus();
    }
  }

  const placeholder = (): Message => ({ id: "pending-a-" + Date.now(), role: "assistant", content: "", model, status: "streaming", error: null, attachments: [], created_at: Date.now() / 1000 });

  /** The web page the user means: an attached .html file, else the newest page in this chat (a file or an html block). */
  async function pageForApp(files: UploadedFile[]): Promise<string | null> {
    for (const f of files) if (/\.x?html?$/i.test(f.name)) { const t = await api.fileText(f.id); if (t) return t; }
    for (const m of [...messages].reverse()) {
      const blocks = [...m.content.matchAll(/```(?:html?|xhtml)\s*\n([\s\S]*?)```/gi)].map((x) => x[1]);
      if (blocks.length) return blocks[blocks.length - 1];
      for (const a of [...m.attachments].reverse()) if (/\.x?html?$/i.test(a.name)) { const t = await api.fileText(a.id); if (t) return t; }
    }
    return null;
  }

  async function send(text: string, files: UploadedFile[], override?: ImageOptions, useModel?: string, note?: string): Promise<boolean> {
    if (busy) return false;
    const writeWith = useModel || model;
    // "convert this html to an apk": with a page attached (or one earlier in the chat), open the app maker directly
    if (APK_REQUEST.test(text) && (files.length || /\b(this|it|that|these|isko|iska|ise|html|page|file|website|site|code)\b/i.test(text))) {
      const page = await pageForApp(files);
      if (page) { setMakeApp(page); return true; }
    }
    speech.stop();                                         // a new question interrupts the current answer
    if (speech.settings.autoSpeak) speech.unlock();        // inside the tap: lets phones play the reply
    const image: ImageOptions | undefined = imagesOn
      ? { ...changedOpts(imageOpts), ...(target ? { source_id: target.id } : {}), ...(override || {}) } : undefined;
    let cid = conversationId;
    if (!cid) {
      try {
        const c = await api.createConversation(writeWith || undefined);
        cid = c.id;
        justCreated.current = c.id;
        onConversationChange(c, true);
        navigate(`/c/${c.id}`);
      } catch (e) {
        toasts.push({ kind: "error", text: e instanceof ApiError ? e.message : "Couldn't start a new chat." });
        return false;
      }
    }
    const userMsg: Message = { id: "pending-u-" + Date.now(), role: "user", content: text, model: null, status: "complete", error: null,
      attachments: files.map(({ id, name, mime, size, kind }) => ({ id, name, mime, size, kind })), created_at: Date.now() / 1000, pending: true };
    setMessages((ms) => [...ms, userMsg, placeholder()]);
    setAtBottom(true);
    const id = cid;
    try {
      if (imageOpts.op === "generate") setImageOpts((o) => ({ ...o, op: undefined }));      // one-shot toggle
      setTarget(null);
      if (writeWith !== model) {                                   // the header shows who writes
        setModel(writeWith);
        onConversationChange({ id, model: writeWith });
        if (note) toasts.push({ kind: "info", text: note }, 6000);
      }
      await runStream((signal) => sendMessage(id, { content: text, model: writeWith, file_ids: files.map((f) => f.id),
        ...(image && Object.keys(image).length ? { image } : {}) },
        handlers(id, (server) => setMessages((ms) => ms.map((m) => (m.id === userMsg.id ? server : m)))), signal));
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
        // rejected before streaming (e.g. image sent to a text-only model): undo and keep the draft
        setMessages((ms) => ms.filter((m) => m.id !== userMsg.id && !(m.role === "assistant" && m.status === "error" && !m.content && m.id.startsWith("pending"))));
        toasts.push({ kind: "error", text: e.message });
        return false;
      }
      return true;
    }
  }

  regenerateRef.current = () => { void regenerate(); };
  regeneratePageRef.current = (id) => { void regeneratePage(id); };
  imageActionRef.current = (action, a) => { void imageAction(action, a); };
  /** A page of a book written again, in its place: the pages after it stay as they are. */
  async function regeneratePage(id: string) {
    if (!conversationId || busy) return;
    if (messages[messages.length - 1]?.id === id) return regenerate();
    speech.stop();
    streamTarget.current = id;
    setAtBottom(false);
    setMessages((ms) => ms.map((m) => (m.id === id ? { ...m, content: "", status: "streaming", error: null, attachments: [], tool: undefined } : m)));
    requestAnimationFrame(() => document.getElementById("msg-" + id)?.scrollIntoView({ block: "start" }));   // stay with the page
    const cid = conversationId;
    try {
      await runStream((signal) => apiRegenerateMessage(cid, id, handlers(cid), signal));
    } catch { /* shown inline */ }
    finally { flushDeltas(); streamTarget.current = null; }
  }

  async function regenerate() {
    if (!conversationId || busy) return;
    speech.stop();
    if (speech.settings.autoSpeak) speech.unlock();
    setMessages((ms) => {
      const out = [...ms];
      while (out.length && out[out.length - 1].role === "assistant") out.pop();
      return [...out, placeholder()];
    });
    const id = conversationId;
    try {
      await runStream((signal) => apiRegenerate(id, handlers(id), signal));
    } catch { /* shown inline */ }
  }

  async function changeModel(next: string) {
    const prev = model;
    userPicked.current = true;
    setModel(next);
    if (conversationId) {
      try { await api.updateConversation(conversationId, { model: next }); onConversationChange({ id: conversationId, model: next }); }
      catch (e) { setModel(prev); toasts.push({ kind: "error", text: e instanceof ApiError ? e.message : "Couldn't switch model." }); }
    }
  }

  async function imageAction(action: ImageAction, a: Attachment) {
    const n = numberOf(a.id);
    const label = n ? `image #${n}` : "this image";
    if (action === "open") setViewing(a);
    else if (action === "edit") { setTarget(a); composer.current?.focus(); }
    else if (action === "mask") setMasking(a);
    else if (action === "variations") await send(`Make variations of ${label}`, [], { op: "variations", source_id: a.id, n: imageOpts.n && imageOpts.n > 1 ? imageOpts.n : 3 });
    else if (action === "remove_background") await send(`Remove the background of ${label}`, [], { op: "remove_background", source_id: a.id, output_format: "png" });
    else if (action === "outpaint") await send(`Expand ${label} to show more around it`, [], { op: "outpaint", source_id: a.id });
    else if (action === "upscale") await send(`Make ${label} larger`, [], { op: "upscale", source_id: a.id, resolution: 2048 });
  }

  async function applyMask(a: Attachment, mask: Blob, instruction: string) {
    setMasking(null);
    try {
      const up = await uploadFile(new File([mask], "mask.png", { type: "image/png" }), () => {}).promise;
      const n = numberOf(a.id);
      const text = instruction ? `In ${n ? "image #" + n : "the image"}, replace the painted area with ${instruction}` : `Remove the painted area from ${n ? "image #" + n : "the image"}`;
      await send(text, [], instruction ? { op: "inpaint", source_id: a.id, mask_id: up.id } : { op: "remove_object", source_id: a.id, mask_id: up.id });
      api.deleteFile(up.id).catch(() => {});
    } catch (e) {
      toasts.push({ kind: "error", text: e instanceof ApiError ? e.message : "Couldn't upload the mask." });
    }
  }

  const stop = () => abort.current?.abort();
  useEffect(() => () => { abort.current?.abort(); if (raf.current) cancelAnimationFrame(raf.current); }, []);

  const current = models.find((m) => m.id === model);
  return (
    <main className="chat" id="main" aria-label="Chat"
          onDragEnter={(e) => { if ([...e.dataTransfer.types].includes("Files")) { dragDepth.current++; setDropping(true); } }}
          onDragLeave={() => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDropping(false); }}
          onDragOver={(e) => { if (dropping) e.preventDefault(); }}
          onDrop={(e) => { dragDepth.current = 0; setDropping(false); if (e.dataTransfer.files.length) { e.preventDefault(); composer.current?.addFiles(e.dataTransfer.files); } }}>
      <header className="chat-head">
        <button type="button" className="icon-btn only-mobile" aria-label="Open conversations" aria-expanded={sidebarOpen}
                aria-controls="sidebar" onClick={onOpenSidebar}>
          <Icon name="menu" />
        </button>
        <h1 className="chat-title" title={title}>{title}</h1>
        <MicIndicator />
        <AutoSpeakToggle />
        <label className="model-picker">
          <span className="sr-only">Model</span>
          <select value={model} onChange={(e) => changeModel(e.target.value)} disabled={busy || models.length === 0}
                  aria-describedby={current?.description ? "model-desc" : undefined}>
            {models.filter((m) => !m.pictures).map((m) => <option key={m.id} value={m.id}>{m.label}{m.vision ? " · images" : ""}</option>)}
            {models.some((m) => m.pictures) && (
              <optgroup label="Make pictures">                                  {/* AI models that make pictures themselves */}
                {models.filter((m) => m.pictures).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </optgroup>
            )}
          </select>
          {current?.description && <span id="model-desc" className="sr-only">{current.description}</span>}
        </label>
      </header>

      <div className="thread" ref={scroller} onScroll={onScroll} role="log" aria-label="Conversation" aria-live="off" tabIndex={-1}>
        <div className="thread-inner">
          {loadState === "loading" && (
            <div className="skeleton-thread" aria-label="Loading conversation" role="status">
              <div className="sk sk-user" /><div className="sk sk-bot" /><div className="sk sk-bot short" />
            </div>
          )}
          {loadState === "error" && (
            <div className="state-box" role="alert">
              <p>Couldn't load this conversation.</p>
              <button type="button" className="btn" onClick={() => conversationId && load(conversationId)}>Try again</button>
            </div>
          )}
          {loadState === "missing" && (
            <div className="state-box" role="alert">
              <p>This conversation doesn't exist or was deleted.</p>
              <button type="button" className="btn primary" onClick={() => navigate("/")}>Start a new chat</button>
            </div>
          )}
          {loadState === "idle" && messages.length === 0 && (
            <div className="empty home">
              <div className="home-mark"><Eye big /></div>
              <p className="home-hello">{greeting()}</p>
              <h2>How can I help?</h2>
              {LOCAL_MODE && (settings.default_model === "echo" || !settings.server_url) && (
                <div className="setup-card" role="note">
                  <div><strong>Connect a real AI to get answers</strong>
                  <p>Only the offline demo is on now. Google Gemini is free: get a key in AI Studio and paste it in Settings → Connection.</p></div>
                  <button type="button" className="btn primary" onClick={() => window.dispatchEvent(new Event("zc:open-settings"))}>Connect AI</button>
                </div>
              )}
              <ul className="tools" aria-label="Quick tools">
                {TOOLS.filter((t) => t.key !== "image" || imagesOn || LOCAL_MODE).map((t) => (
                  <li key={t.key}>
                    <button type="button" className={`tool tone-${t.tone}`}
                            onClick={() => t.run === "camera" ? composer.current?.openCamera() : t.run === "files" ? composer.current?.pickFiles() : composer.current?.setText(t.run)}>
                      <span className="tool-ico" aria-hidden="true"><Icon name={t.icon} size={22} /></span>
                      <span className="tool-label">{t.label}</span>
                    </button>
                  </li>
                ))}
              </ul>
              <div className="ideas">
                <h3>Try asking</h3>
                <ul>
                  {ideas.map((s) => (
                    <li key={s}><button type="button" className="suggestion" onClick={() => composer.current?.setText(s)}>
                      <span>{s}</span><Icon name="send" size={16} /></button></li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          {loadState === "idle" && messages.map((m, i) => (
            <MessageView key={m.id} m={m} book={bookPages.has(m.id)} isLast={i === messages.length - 1} busy={busy} models={models}
                         request={askedFor[i]}
                         showTime={settings.show_timestamps} onRegenerate={onRegenerate}
                         onRegeneratePage={bookPages.has(m.id) ? onRegeneratePage : undefined}
                         onImageAction={onImageAction} imageActions={imagesOn && !busy} numberOf={numberOf}
                         fileHref={messageFileHref} imageOps={caps?.ops} />
          ))}
          {loadState === "idle" && book && (messages[messages.length - 1]?.id === book.replies[book.replies.length - 1] ? (
            <BookBar book={book} messages={messages} busy={busy} onNext={(t) => void send(t, [])} />
          ) : messages[messages.length - 1]?.role === "assistant" && !book.complete && (
            // a question asked between pages: the way back into the book stays at hand
            <BookBar compact book={book} messages={messages} busy={busy} onNext={(t) => void send(t, [])} />
          ))}
        </div>
      </div>

      {!atBottom && messages.length > 0 && (
        <button type="button" className="jump" onClick={jumpToLatest} aria-label="Jump to latest message">
          <Icon name="down" size={16} />
        </button>
      )}
      <div className="sr-only" aria-live="polite" role="status">{announce}</div>
      {viewing && <Lightbox a={viewing} src={fileUrl(viewing.id)} download={fileUrl(viewing.id, true)} onClose={() => setViewing(null)} onAction={imageAction}
                              canPaint={!caps || caps.ops.includes("inpaint")} />}
      {play !== null && <PlayDialog target={play} onClose={() => setPlay(null)} />}
      {site !== null && <SitePreview html={site} onClose={() => setSite(null)} />}
      {makeApp !== null && <MakeAppDialog html={makeApp} onClose={() => setMakeApp(null)} />}
      {preview && <FilePreview f={preview} onClose={() => setPreview(null)} />}
      {dropping && <div className="drop-overlay" aria-hidden="true"><div><Icon name="clip" size={34} /><strong>Add anything</strong><span>Drop files here to add them to your message</span></div></div>}
      {masking && <MaskEditor a={masking} src={fileUrl(masking.id)} onCancel={() => setMasking(null)} onApply={(b, t) => applyMask(masking, b, t)} />}
      <div className="composer-wrap">
        <VoicePanel />
        <Composer ref={composer} busy={busy} sendOnEnter={settings.send_on_enter} onStop={stop}
                  onSend={(t, f) => {
                    if (isBookRequest(t)) return send(t, f, undefined, bestBook?.id);
                    const coder = !userPicked.current && isProjectRequest(t) ? bestProjectModel(models, model, f.some((x) => x.kind === "image")) : null;
                    return send(t, f, undefined, coder?.id, coder ? `Writing this project with ${modelName(coder.id)}, a stronger coding model. You can change it at the top.` : undefined);
                  }}
                  placeholder={target ? `Describe the change to image #${numberOf(target.id) ?? ""}…` : imageOpts.op === "generate" ? "Describe the image to create…"
                    : current?.pictures ? `Describe a picture for ${current.label.replace(/ \(free\)$/, "")} to make…` : undefined}
                  menu={[
                    { key: "voice", icon: "wave", label: "Voice conversation", hint: "Talk and listen, hands-free", ariaLabel: "Start voice conversation",
                      onSelect: () => { speech.unlock(); void voice.start({ send: (t) => send(t, []), stopReply: stop, busy: () => busyRef.current }); } },
                    ...(imagesOn ? [
                    { key: "image", icon: "image", label: "Create image", hint: "Your next message makes a picture", on: imageOpts.op === "generate",
                      onSelect: () => { setImageOpts((o) => ({ ...o, op: o.op === "generate" ? undefined : "generate" })); composer.current?.focus(); } },
                    { key: "image-settings", icon: "sliders", label: "Image settings", hint: "Style, shape, size, how many", ariaLabel: "Image settings",
                      on: Object.keys(changedOpts({ ...imageOpts, op: undefined })).length > 0, onSelect: () => setShowImageSettings(true) },
                  ] : []),
                  ]}
                  chips={imageOpts.op === "generate" ? (
                    <span className="mode-chip" role="status">
                      <Icon name="image" size={15} /><span>Image</span><span className="sr-only"> — your next message will create an image</span>
                      <button type="button" aria-label="Cancel image mode" onClick={() => setImageOpts((o) => ({ ...o, op: undefined }))}><Icon name="close" size={13} /></button>
                    </span>) : undefined}
                  popover={showImageSettings && caps ? <ImageSettings caps={caps} opts={imageOpts} setOpts={setImageOpts} onClose={() => setShowImageSettings(false)} /> : undefined}
                  banner={target ? (
                    <div className="edit-target" role="status">
                      <img src={fileUrl(target.id)} alt="" />
                      <span>Editing <strong>image #{numberOf(target.id)}</strong> — describe the change</span>
                      <button type="button" className="icon-btn small" aria-label="Stop editing this image" onClick={() => setTarget(null)}><Icon name="close" size={14} /></button>
                    </div>) : undefined} />
      </div>
    </main>
  );
}
