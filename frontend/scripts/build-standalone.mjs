// Builds ONE self-contained HTML file (JS + CSS inlined, no external requests) for opening directly in a browser
// or packaging inside the Android APK. Uses api/local.ts instead of the FastAPI client.
//   node scripts/build-standalone.mjs        →  dist-standalone/zenvqo-chat.html  (+ copy into the Android assets)
import { build, transform } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

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

// pdf.js (PDF reading) is bundled as text and started on demand from a blob: URL — see src/pdf/read.ts
const pdfjsDir = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
// the pdf.js worker is its own global: it gets the same polyfills as the page (src/polyfills.ts) for older WebViews
const WORKER_POLYFILLS = (await build({ entryPoints: [resolve(root, "src/polyfills.ts")], bundle: true, write: false, format: "iife",
  minify: true, target: "chrome80", logLevel: "warning" })).outputFiles[0].text +
  // the plain-JS image decoders, when the page supplied them (self.__zvqFallbackSrc: file name → script)
  `self.__zvqFallback = async (name) => { const src = (self.__zvqFallbackSrc || {})[name.replace(/\\.js$/, ".iife.js")];
     if (!src) throw new Error("decoder not available: " + name); return new Function(src + "\\n;return __zvqModule;")(); };`;
const pdfjsText = {
  name: "pdfjs-text",
  setup(b) {
    b.onResolve({ filter: /^pdfjs-text:/ }, (args) => ({ path: args.path.slice(11), namespace: "pdfjs-text" }));
    b.onLoad({ filter: /.*/, namespace: "pdfjs-text" }, async (args) => {
      let src = readFileSync(resolve(pdfjsDir, `legacy/build/pdf${args.path === "worker" ? ".worker" : ""}.min.mjs`), "utf8");
      if (args.path === "worker") {
        // WebViews without WebAssembly SIMD (Chrome < 91) decode JPEG 2000 / JBIG2 scans with pdf.js's plain-JS decoders,
        // which it would import() from a URL; the app hands them to the worker as source instead (see src/pdf/read.ts)
        const re = /\(await import\(\s*\/\*webpackIgnore: true\*\/\s*\/\*@vite-ignore\*\/\s*`\$\{WasmImage\.#\w+\}\$\{this\._noWasmFilename\}`\)\)/;
        if (!re.test(src)) throw new Error("pdf.js worker: fallback import not found — update the patch in build-standalone.mjs");
        src = src.replace(re, "(await self.__zvqFallback(this._noWasmFilename))");
      }
      // lowered for older Android WebViews (Chrome 80+: no private methods / static blocks there); the worker runs as a
      // classic script, since module workers from blob: URLs fail on file:// pages (the Android app)
      const contents = (await transform(src, { format: args.path === "worker" ? "iife" : "esm", minify: true, target: "chrome80",
        legalComments: "none", logLevel: "silent", banner: args.path === "worker" ? WORKER_POLYFILLS : "" })).code;
      return { contents, loader: "text" };
    });
  },
};

const r = await build({
  entryPoints: [resolve(root, "src/main.tsx")], bundle: true, minify: true, format: "esm", target: "es2020",
  jsx: "automatic", write: false, outdir: "out", plugins: [swapApi, pdfjsText], logLevel: "warning",
  define: { "process.env.NODE_ENV": '"production"' }, loader: { ".css": "css", ".woff2": "dataurl", ".woff": "empty", ".ttf": "empty" }, legalComments: "eof",
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
  // data files the PDF reader needs for some PDFs (CJK fonts, standard fonts, JPEG 2000/JBIG2 scans, CMYK colours)
  const data = resolve(assets, "pdfjs");
  rmSync(data, { recursive: true, force: true });
  let bytes = 0;
  for (const [dir, keep] of [["cmaps", /\.bcmap$|LICENSE/], ["standard_fonts", /./], ["wasm", /^(jbig2|openjpeg|qcms_bg)\.wasm$|LICENSE/], ["iccs", /./]]) {
    mkdirSync(resolve(data, dir), { recursive: true });
    for (const f of readdirSync(resolve(pdfjsDir, dir))) {
      if (!keep.test(f)) continue;
      copyFileSync(resolve(pdfjsDir, dir, f), resolve(data, dir, f));
      bytes += statSync(resolve(data, dir, f)).size;
    }
  }
  for (const f of ["openjpeg_nowasm_fallback.js", "jbig2_nowasm_fallback.js"]) {         // as plain scripts (see above)
    const code = (await transform(readFileSync(resolve(pdfjsDir, "wasm", f), "utf8"), { format: "iife", globalName: "__zvqModule",
      minify: true, target: "chrome80", legalComments: "none", logLevel: "silent" })).code;
    writeFileSync(resolve(data, "wasm", f.replace(/\.js$/, ".iife.js")), code);
    bytes += code.length;
  }
  console.log("pdf.js data →", data, (bytes / 1024 / 1024).toFixed(1), "MB");
}
