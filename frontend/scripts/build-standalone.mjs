// Builds ONE self-contained HTML file (JS + CSS inlined, no external requests) for opening directly in a browser
// or packaging inside the Android APK. Uses api/local.ts instead of the FastAPI client.
//   node scripts/build-standalone.mjs        →  dist-standalone/zenvqo-chat.html  (+ copy into the Android assets)
import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const localApi = resolve(root, "src/api/local.ts");

const swapApi = {
  name: "standalone-api",
  setup(b) {
    b.onResolve({ filter: /(^|\/)api\/client$|^\.\/client$/ }, (args) => {
      if (args.path === "./client" && !args.importer.includes("/api/")) return undefined;
      return { path: localApi };
    });
  },
};

const r = await build({
  entryPoints: [resolve(root, "src/main.tsx")], bundle: true, minify: true, format: "esm", target: "es2020",
  jsx: "automatic", write: false, outdir: "out", plugins: [swapApi], logLevel: "warning",
  define: { "process.env.NODE_ENV": '"production"' }, loader: { ".css": "css" }, legalComments: "eof",
});
const js = r.outputFiles.find((f) => f.path.endsWith(".js")).text.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
const css = r.outputFiles.find((f) => f.path.endsWith(".css")).text;
const html = readFileSync(resolve(root, "index.html"), "utf8")
  // function replacers: the minified code contains "$'" / "$&", which string replacements would expand
  .replace('<script type="module" src="/src/main.tsx"></script>', () => `<script type="module">\n${js}\n</script>`)
  .replace("</head>", () => `  <meta name="description" content="zenvqo chat — standalone" />\n    <style>\n${css}\n</style>\n  </head>`);
const outDir = resolve(root, "dist-standalone");
mkdirSync(outDir, { recursive: true });
const out = resolve(outDir, "zenvqo-chat.html");
writeFileSync(out, html);
console.log(out, (html.length / 1024).toFixed(0), "KB");
const assets = resolve(root, "../android/app/src/main/assets");
if (existsSync(resolve(root, "../android"))) {
  mkdirSync(assets, { recursive: true });
  copyFileSync(out, resolve(assets, "index.html"));
  console.log("copied →", resolve(assets, "index.html"));
}
