// PDF status per reply (making → saved / ready / failed), remembered on this device so the card survives a reload.
import { makePdf, type PdfResult, pdfTitle } from "./pdf";

export interface PdfState { status: "making" | "saved" | "ready" | "error"; result?: PdfResult; error?: string; title: string }
const KEY = "zc.pdfs";
let states: Record<string, PdfState> = {};
try { states = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { states = {}; }
const subs = new Set<() => void>();

function set(id: string, s: PdfState) {
  states = { ...states, [id]: s };
  try {
    const keep = Object.fromEntries(Object.entries(states).filter(([, v]) => v.status === "saved" && v.result?.kind === "file").slice(-200));
    localStorage.setItem(KEY, JSON.stringify(keep));
  } catch { /* private mode */ }
  subs.forEach((f) => f());
}

export const pdfStore = {
  get: (id: string): PdfState | undefined => states[id],
  subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f); }; },
  /** create the PDF for a reply; `request` is the user's message (used for the title when the reply has no heading) */
  async make(id: string, reply: string, request = "") {
    const title = pdfTitle(reply, request);
    set(id, { status: "making", title });
    try {
      const r = await makePdf(title, reply);
      set(id, { status: r.kind === "dialog" ? "ready" : "saved", result: r, title });
    } catch (e) {
      set(id, { status: "error", error: (e as Error).message, title });
    }
  },
  /** browsers: a card that offers the print dialog (needs a tap) */
  offer(id: string, reply: string, request = "") { set(id, { status: "ready", title: pdfTitle(reply, request) }); },
};
