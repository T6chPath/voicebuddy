import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

export interface Toast { id: number; kind: "info" | "success" | "error"; text: string; action?: { label: string; run: () => void } }
interface Ctx { push: (t: Omit<Toast, "id">, ms?: number) => void; dismiss: (id: number) => void }
const ToastCtx = createContext<Ctx>({ push: () => {}, dismiss: () => {} });
export const useToasts = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((t) => t.id !== id)), []);
  const push = useCallback((t: Omit<Toast, "id">, ms = t.kind === "error" ? 8000 : 4000) => {
    const id = next.current++;
    setItems((xs) => [...xs.slice(-3), { ...t, id }]);
    window.setTimeout(() => dismiss(id), ms);
  }, [dismiss]);
  const value = useMemo(() => ({ push, dismiss }), [push, dismiss]);
  return (
    <ToastCtx.Provider value={value}>
      {children}
      {/* errors are announced assertively, everything else politely */}
      <div className="toasts" aria-live="polite">
        {items.filter((t) => t.kind !== "error").map((t) => <ToastView key={t.id} t={t} dismiss={dismiss} />)}
      </div>
      <div className="toasts toasts-errors" aria-live="assertive">
        {items.filter((t) => t.kind === "error").map((t) => <ToastView key={t.id} t={t} dismiss={dismiss} />)}
      </div>
    </ToastCtx.Provider>
  );
}

function ToastView({ t, dismiss }: { t: Toast; dismiss: (id: number) => void }) {
  return (
    <div className={`toast toast-${t.kind}`}>
      <span>{t.text}</span>
      {t.action && <button type="button" className="btn-link" onClick={() => { t.action!.run(); dismiss(t.id); }}>{t.action.label}</button>}
      <button type="button" className="icon-btn small" aria-label="Dismiss notification" onClick={() => dismiss(t.id)}>×</button>
    </div>
  );
}
