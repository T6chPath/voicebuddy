import { useCallback, useEffect, useState } from "react";
import { LOCAL_MODE } from "../api/client";

/** Two routes: "/" (new chat) and "/c/:id". History API on a server; hash URLs (#/c/:id) in the standalone file/APK,
 * where the page is opened from file:// or an asset URL and the path can't change. */
export function parse(path: string): { conversationId: string | null } {
  const m = path.match(/^\/c\/([A-Za-z0-9_-]{1,80})\/?$/);
  return { conversationId: m ? m[1] : null };
}

const current = () => (LOCAL_MODE ? window.location.hash.replace(/^#/, "") || "/" : window.location.pathname);

export function useRoute() {
  const [path, setPath] = useState(current);
  useEffect(() => {
    const on = () => setPath(current());
    window.addEventListener("popstate", on);
    window.addEventListener("hashchange", on);
    return () => { window.removeEventListener("popstate", on); window.removeEventListener("hashchange", on); };
  }, []);
  const navigate = useCallback((to: string, replace = false) => {
    if (to === current()) return;
    const url = LOCAL_MODE ? "#" + to : to;
    if (replace) window.history.replaceState(null, "", url);
    else window.history.pushState(null, "", url);
    setPath(to);
  }, []);
  return { ...parse(path), navigate };
}
