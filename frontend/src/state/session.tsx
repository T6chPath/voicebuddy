import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, ApiError, LOCAL_MODE, setUnauthorizedHandler } from "../api/client";
import type { ModelInfo, User, UserSettings } from "../api/types";

export const DEFAULT_SETTINGS: UserSettings = {
  theme: "system", default_model: "", temperature: 0.7, system_prompt: "", font_size: "medium", send_on_enter: true, show_timestamps: false,
};

interface Session {
  user: User | null;
  status: "loading" | "signed-out" | "signed-in" | "offline";
  settings: UserSettings;
  models: ModelInfo[];
  signIn: (u: User) => void;
  signOut: () => Promise<void>;
  saveSettings: (s: UserSettings) => Promise<void>;
  retry: () => void;
}
const Ctx = createContext<Session | null>(null);
export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error("useSession outside provider");
  return s;
}

export function applyTheme(s: Pick<UserSettings, "theme" | "font_size">) {
  const root = document.documentElement;
  root.dataset.theme = s.theme;
  root.dataset.font = s.font_size;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<Session["status"]>("loading");
  const [settings, setSettings] = useState<UserSettings>(() => {
    try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem("zc.settings") || "{}") }; } catch { return DEFAULT_SETTINGS; }
  });
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => { applyTheme(settings); }, [settings]);

  const loadAccountData = useCallback(async () => {
    const [s, m] = await Promise.all([api.settings(), api.models()]);
    setSettings(s);
    setModels(m.items);
    try { localStorage.setItem("zc.settings", JSON.stringify({ theme: s.theme, font_size: s.font_size })); } catch { /* private mode */ }
  }, []);

  useEffect(() => {
    let alive = true;
    api.me()
      .then(async (u) => { if (!alive) return; setUser(u); await loadAccountData(); if (alive) setStatus("signed-in"); })
      .catch((e: ApiError) => { if (alive) setStatus(e.isNetwork ? "offline" : "signed-out"); });
    return () => { alive = false; };
  }, [attempt, loadAccountData]);

  useEffect(() => setUnauthorizedHandler(() => { setUser(null); setStatus("signed-out"); }), []);

  const signIn = useCallback((u: User) => {
    setUser(u);
    setStatus("loading");
    loadAccountData().then(() => setStatus("signed-in")).catch(() => setStatus("offline"));
  }, [loadAccountData]);

  const signOut = useCallback(async () => {
    try { await api.logout(); } finally { setUser(null); setStatus("signed-out"); }
  }, []);

  const saveSettings = useCallback(async (s: UserSettings) => {
    const saved = await api.saveSettings(s);
    setSettings(saved);
    if (LOCAL_MODE) setModels((await api.models()).items);       // the server address may have changed
    try { localStorage.setItem("zc.settings", JSON.stringify({ theme: saved.theme, font_size: saved.font_size })); } catch { /* ignore */ }
  }, []);

  const value = useMemo(() => ({ user, status, settings, models, signIn, signOut, saveSettings, retry: () => { setStatus("loading"); setAttempt((a) => a + 1); } }),
    [user, status, settings, models, signIn, signOut, saveSettings]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
