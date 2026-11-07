import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../styles.css";
import "./standalone.css";
import { applyTheme } from "../state/session";
import App from "./App";

try {
  const d = JSON.parse(localStorage.getItem("zenvqo.standalone.v1") || "{}");
  applyTheme({ theme: d.settings?.theme || "system", font_size: d.settings?.font_size || "medium" });
} catch { /* first run */ }

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
