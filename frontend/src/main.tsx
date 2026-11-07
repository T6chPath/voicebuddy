import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { applyTheme } from "./state/session";
import "./styles.css";

try {                                                  // apply saved theme before first paint (no flash)
  applyTheme({ theme: "system", font_size: "medium", ...JSON.parse(localStorage.getItem("zc.settings") || "{}") });
} catch { /* ignore */ }

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
