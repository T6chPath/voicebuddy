// Offline production build with esbuild (used where `npm install` / Vite isn't available).
// Normal path: `npm run build` (Vite). Output layout is the same: dist/index.html + dist/assets/*.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync, renameSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist/assets", { recursive: true });
const r = await build({
  entryPoints: ["src/main.tsx"], bundle: true, minify: true, sourcemap: true, format: "esm", target: "es2022",
  jsx: "automatic", outdir: "dist/assets", entryNames: "app", metafile: true,
  define: { "process.env.NODE_ENV": '"production"' }, loader: { ".css": "css", ".woff2": "file", ".woff": "empty", ".ttf": "empty" }, assetNames: "fonts/[name]-[hash]", logLevel: "warning",
});
const hash = (f) => createHash("sha256").update(readFileSync(f)).digest("hex").slice(0, 10);
const js = `app-${hash("dist/assets/app.js")}.js`, css = `app-${hash("dist/assets/app.css")}.css`;
renameSync("dist/assets/app.js", `dist/assets/${js}`);
renameSync("dist/assets/app.css", `dist/assets/${css}`);
let html = readFileSync("index.html", "utf8").replace('<script type="module" src="/src/main.tsx"></script>',
  () => `<script type="module" src="/assets/${js}"></script>`).replace("</head>", () => `  <link rel="stylesheet" href="/assets/${css}" />\n  </head>`);
writeFileSync("dist/index.html", html);
const out = r.metafile.outputs;
for (const [k, v] of Object.entries(out)) if (!k.endsWith(".map")) console.log(k.replace("app.", `app-*.`), (v.bytes / 1024).toFixed(1), "KB");
