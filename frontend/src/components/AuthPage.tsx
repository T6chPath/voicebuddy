import { useId, useState, type FormEvent } from "react";
import { api, ApiError } from "../api/client";
import { useSession } from "../state/session";

export function AuthPage() {
  const { signIn } = useSession();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPw, setShowPw] = useState(false);
  const errId = useId();

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const email = String(f.get("email") || "").trim();
    const password = String(f.get("password") || "");
    setBusy(true);
    setError(null);
    try {
      const u = mode === "login" ? await api.login(email, password) : await api.register(email, String(f.get("name") || "").trim(), password);
      signIn(u);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth" id="main">
      <div className="auth-card">
        <div className="brand" aria-hidden="true">z</div>
        <h1>{mode === "login" ? "Sign in to zenvqo" : "Create your account"}</h1>
        <form onSubmit={submit} noValidate={false} aria-describedby={error ? errId : undefined}>
          {mode === "register" && (
            <label className="field">
              <span>Name</span>
              <input name="name" autoComplete="name" required maxLength={80} />
            </label>
          )}
          <label className="field">
            <span>Email</span>
            <input name="email" type="email" autoComplete="email" inputMode="email" required maxLength={254} autoFocus />
          </label>
          <label className="field">
            <span>Password</span>
            <div className="pw">
              <input name="password" type={showPw ? "text" : "password"} required minLength={mode === "register" ? 8 : 1}
                     autoComplete={mode === "login" ? "current-password" : "new-password"} maxLength={200} />
              <button type="button" className="btn-link" onClick={() => setShowPw((v) => !v)} aria-pressed={showPw}>
                {showPw ? "Hide" : "Show"}
              </button>
            </div>
            {mode === "register" && <small className="hint">At least 8 characters.</small>}
          </label>
          {error && <p className="form-error" id={errId} role="alert">{error}</p>}
          <button className="btn primary wide" type="submit" disabled={busy} aria-busy={busy}>
            {busy && <span className="spinner" aria-hidden="true" />}
            {mode === "login" ? (busy ? "Signing in…" : "Sign in") : (busy ? "Creating account…" : "Create account")}
          </button>
        </form>
        <p className="switch">
          {mode === "login" ? "New here?" : "Already have an account?"}{" "}
          <button type="button" className="btn-link" onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(null); }}>
            {mode === "login" ? "Create an account" : "Sign in"}
          </button>
        </p>
      </div>
    </main>
  );
}
