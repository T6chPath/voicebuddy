/** "Google Play package": a web page → a folder with everything Google Play Console needs, built on the phone by the
 * Android app (window.ZenvqoPlay): the signed App Bundle (.aab — Play doesn't take APKs for new apps), store pictures,
 * screenshots, the upload key, and the texts made here: store listing, privacy policy, data-safety answers, and a
 * step-by-step guide. */
import { Zip } from "../files/zip";

interface NativePlay {
  status(): string;
  hasKey(pkg: string): boolean;
  make(id: string, json: string): void;
  share(id: string): void;
}
declare global { interface Window { ZenvqoPlay?: NativePlay; __zplay?: (id: string, ev: string, data: string) => void } }

export interface PlayResult {
  id: string; saved: string; size: number; aab: number; aabName: string; folder: string; pkg: string;
  versionCode: number; versionName: string; shots: number; newKey: boolean; sha256: string;
}
export interface PlayInput {
  html: string; name: string; pkg: string; versionCode: number; versionName: string; icon: string;
  short: string; full: string; email: string; website: string;
}

type Handler = (ev: string, data: string) => void;
const handlers = new Map<string, Handler>();
let seq = 0;

export function playAvailable(): { ok: boolean; reason: string } {
  const b = typeof window !== "undefined" ? window.ZenvqoPlay : undefined;
  if (!b) return { ok: false, reason: "Making Google Play packages works in the zenvqo Android app — open this chat there." };
  try {
    const s = JSON.parse(b.status()) as { ready: boolean; reason?: string };
    return { ok: s.ready, reason: s.reason || "" };
  } catch { return { ok: false, reason: "The Google Play maker isn't available in this build." }; }
}

export const hasUploadKey = (pkg: string) => { try { return !!window.ZenvqoPlay?.hasKey(pkg); } catch { return false; } };
export const sharePlay = (id: string) => window.ZenvqoPlay?.share(id);

/* ---------------- names and versions ---------------- */

/** "Chai Shop!" → "com.chaishop.app" */
export function suggestPackage(name: string): string {
  const word = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "").replace(/^[0-9]+/, "").slice(0, 30) || "myapp";
  return `com.${word}.app`;
}

const RESERVED = new Set(("abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally " +
  "float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp " +
  "super switch synchronized this throw throws transient try void volatile while true false null").split(" "));

/** Why a package name can't be used on Google Play ("" = fine). */
export function packageProblem(p: string): string {
  if (!p) return "Enter a package name, like com.yourname.appname.";
  if (p.length > 150) return "The package name is too long.";
  const parts = p.split(".");
  if (parts.length < 2) return "Use at least two parts with a dot between them, like com.yourname.appname.";
  if (parts.some((x) => !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(x))) return "Each part must start with a letter and use only letters, numbers or _.";
  if (parts.some((x) => RESERVED.has(x))) return "A part of the package name is a reserved Java word (like “new” or “class”).";
  if (/^com\.example(\.|$)/i.test(p)) return "Google Play doesn't accept com.example — use your own name.";
  return "";
}

const VERSIONS = "zc-play-versions";
function versions(): Record<string, number> { try { return JSON.parse(localStorage.getItem(VERSIONS) || "{}"); } catch { return {}; } }
/** The next version code for this package (1 the first time; Play needs a higher number for every upload). */
export function nextVersionCode(pkg: string): number { return (versions()[pkg] || 0) + 1; }
export function rememberVersion(pkg: string, code: number) {
  const v = versions();
  v[pkg] = Math.max(v[pkg] || 0, code);
  try { localStorage.setItem(VERSIONS, JSON.stringify(v)); } catch { /* private mode */ }
}

/* ---------------- what the page does (for the data-safety answers) ---------------- */

export interface PageFacts { internet: boolean; forms: boolean; storage: boolean; camera: boolean; microphone: boolean; location: boolean; external: string[] }

export function pageFacts(html: string): PageFacts {
  const hosts = new Set<string>();
  for (const m of html.matchAll(/\b(?:src|href|action)\s*=\s*["'](https?:\/\/[^"'/]+)/gi)) hosts.add(m[1].replace(/^https?:\/\//, ""));
  for (const m of html.matchAll(/\b(?:fetch|open)\s*\(\s*["'`](https?:\/\/[^"'`/]+)/gi)) hosts.add(m[1].replace(/^https?:\/\//, ""));
  const sends = /\bfetch\s*\(|XMLHttpRequest|WebSocket\s*\(|navigator\.sendBeacon|<form[^>]+action\s*=\s*["']https?:/i.test(html);
  return {
    internet: sends || hosts.size > 0,
    forms: /<form\b|<input\b|<textarea\b/i.test(html),
    storage: /localStorage|sessionStorage|indexedDB/i.test(html),
    camera: /getUserMedia[\s\S]{0,80}video|capture\s*=\s*["']?(environment|user)/i.test(html),
    microphone: /getUserMedia[\s\S]{0,80}audio|SpeechRecognition/i.test(html),
    location: /navigator\.geolocation/i.test(html),
    external: [...hosts].slice(0, 12),
  };
}

/* ---------------- store texts ---------------- */

const clean = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
const cut = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…");

/** A first draft of the store texts from the page itself. */
export function draftListing(html: string, name: string): { short: string; full: string } {
  const meta = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i)?.[1];
  const paras = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => clean(m[1])).filter((t) => t.length > 25);
  const heads = [...html.matchAll(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi)].map((m) => clean(m[1])).filter((t) => t.length > 2 && t.length < 60);
  const lead = clean(meta || paras[0] || `${name} — simple, fast and works offline.`);
  const short = cut(lead, 80);
  const lines = [lead, ""];
  if (heads.length) { lines.push(`What you'll find in ${name}:`); for (const h of [...new Set(heads)].slice(0, 8)) lines.push(`• ${h}`); lines.push(""); }
  if (paras.length > 1) lines.push(...paras.slice(1, 4), "");
  lines.push(`${name} opens instantly from its own icon and works without an account.`);
  return { short, full: cut(lines.join("\n").trim(), 4000) };
}

/** Better store texts from the chat's AI, when one is set up. */
export async function aiListing(html: string, name: string, ask: (prompt: string) => Promise<string | null>): Promise<{ short: string; full: string } | null> {
  const page = clean(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")).slice(0, 6000);
  const out = await ask(`Write the Google Play Store listing for an Android app called "${name}". Here is the text of the app's page:\n\n${page}\n\n` +
    `Reply with JSON only, no code fence: {"short": "...", "full": "..."}. "short" is the short description: at most 80 characters, no app name, no emoji, no words like "best", "#1" or "free" in capitals. ` +
    `"full" is the full description: 600 to 2500 characters, plain text with short paragraphs and "• " bullet lines for features, honest about what the app does, no keyword stuffing, no mentions of other apps, no prices or promotions.`);
  if (!out) return null;
  try {
    const j = JSON.parse(out.replace(/^```(?:json)?\s*|\s*```$/g, "").match(/\{[\s\S]*\}/)?.[0] || "") as { short?: string; full?: string };
    if (!j.short || !j.full) return null;
    return { short: cut(clean(j.short), 80), full: cut(j.full.trim(), 4000) };
  } catch { return null; }
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

export function privacyPolicy(name: string, email: string, f: PageFacts, today = new Date()): string {
  const date = today.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const contact = email ? `<a href="mailto:${esc(email)}">${esc(email)}</a>` : "[your email address]";
  const items: string[] = [];
  if (f.storage) items.push("<li>What you save in the app (for example notes, lists, scores or settings) is stored only on your device. It is not sent to us, and it is deleted when you uninstall the app or clear its data.</li>");
  if (f.forms) items.push("<li>Text you type into the app stays on your device unless the app clearly says it will send it somewhere.</li>");
  if (f.camera) items.push("<li>If you allow the camera, pictures are used only inside the app while you use that feature and are not uploaded by the app.</li>");
  if (f.microphone) items.push("<li>If you allow the microphone, sound is used only while you use that feature.</li>");
  if (f.location) items.push("<li>If you allow location, it is used only on your device while you use that feature and is not stored by us.</li>");
  if (f.internet) items.push(`<li>The app loads some content from the internet${f.external.length ? ` (${esc(f.external.join(", "))})` : ""}. Those services may receive technical information such as your IP address, as with any website visit; please see their own privacy policies.</li>`);
  if (!items.length) items.push("<li>The app works entirely on your device.</li>");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name)} — Privacy policy</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;color:#1b2333}h1{font-size:1.6em}h2{font-size:1.15em;margin-top:1.6em}</style></head>
<body>
<h1>${esc(name)} — Privacy policy</h1>
<p>Last updated: ${date}</p>
<p>This policy explains how the Android app <strong>${esc(name)}</strong> (“the app”) handles your information.</p>
<h2>Information the app collects</h2>
<p>The app does not ask you to create an account, and we do not collect, sell or share your personal information.</p>
<ul>
${items.join("\n")}
</ul>
<h2>Advertising and analytics</h2>
<p>The app shows no ads and uses no analytics or tracking tools.</p>
<h2>Children</h2>
<p>The app does not knowingly collect personal information from anyone, including children.</p>
<h2>Changes</h2>
<p>If this policy changes, the new version will be posted on this page with a new date.</p>
<h2>Contact</h2>
<p>Questions about this policy: ${contact}</p>
</body></html>
`;
}

export function dataSafety(name: string, f: PageFacts): string {
  const net = f.internet;
  return `DATA SAFETY — answers for ${name}
(Play Console → Policy and programs → App content → Data safety)

These answers are a starting point based on what the app's page does. Check them: you are responsible for what you declare.

1. Does your app collect or share any of the required user data types?
   → ${net ? "Check carefully. The page talks to the internet" + (f.external.length ? ` (${f.external.join(", ")})` : "") + ". If it sends anything the user types or any personal data there, answer Yes and declare those data types. If it only loads fonts, pictures or scripts, you can usually answer No." : "No. The app keeps everything on the device and sends nothing anywhere."}

2. Is all of the user data collected by your app encrypted in transit?
   → ${net ? "Yes, if every web address the page uses starts with https://." : "Not applicable (nothing is sent)."}

3. Do you provide a way for users to request that their data is deleted?
   → ${net ? "Answer to match your service." : "Not applicable: data stays on the device; uninstalling the app or clearing its storage deletes it."}

What the app does with data, from its page:
• Saves data on the device (localStorage): ${f.storage ? "yes — this is NOT “collection” in Play's sense, because it never leaves the device" : "no"}
• Forms or text boxes: ${f.forms ? "yes" : "no"}
• Camera: ${f.camera ? "yes" : "no"}   • Microphone: ${f.microphone ? "yes" : "no"}   • Location: ${f.location ? "yes" : "no"}
• Talks to the internet: ${net ? "yes" : "no"}
• Ads, analytics, accounts, payments: none built in

Other App content answers:
• Ads: “No, my app does not contain ads.”
• App access: “All functionality is available without special access.”
• Content rating: fill in the questionnaire honestly (category: usually “All other app types”).
• Target audience: choose the ages your app is for. If you pick ages under 13, Google's Families policy applies.
• Government apps / financial features / health / news: answer No unless your app is one of these.
`;
}

export function listingText(name: string, short: string, full: string, email: string, website: string): string {
  return `STORE LISTING — ${name}
(Play Console → Grow users → Store presence → Main store listing)

App name (max 30 characters):
${name}

Short description (max 80 characters):
${short}

Full description (max 4000 characters):
${full}

Graphics (in the store-listing folder):
• App icon: app-icon-512.png (512 × 512)
• Feature graphic: feature-graphic-1024x500.jpg (1024 × 500)
• Phone screenshots: phone-screenshot-*.jpg (1080 × 1920). Play needs at least 2 — if there is only 1, add another one (open the app on your phone and press Power + Volume down).

Contact details:
• Email: ${email || "(your email — Play shows it on the store page)"}
• Website: ${website || "(optional)"}
`;
}

export function howToPublish(r: { name: string; pkg: string; aabName: string; versionCode: number; versionName: string; update: boolean }): string {
  return `HOW TO PUBLISH ${r.name.toUpperCase()} ON GOOGLE PLAY
Package name: ${r.pkg}    Version: ${r.versionName} (version code ${r.versionCode})

WHAT'S IN THIS FOLDER
• ${r.aabName} — the app (Android App Bundle). This is the file you upload. Google Play takes .aab files, not .apk files, for new apps.
• store-listing/ — app icon, feature graphic and phone screenshots.
• listing.txt — app name, short and full description, ready to paste.
• privacy-policy.html — your privacy policy. Play needs it as a web address (see step 4).
• data-safety.txt — answers for the Data safety and App content forms.
• upload-key-KEEP-PRIVATE/ — the key this app is signed with. Never upload or share it. Keep a copy somewhere safe.

The app targets Android 16 (API level 36), which Google Play requires for new apps and updates.

${r.update ? `THIS IS AN UPDATE
1. Play Console → your app → Test and release → Production (or your testing track) → Create new release.
2. Upload ${r.aabName}. It's signed with the same upload key as before and has a higher version code (${r.versionCode}).
3. Write what's new in “Release notes”, then Next → Save → Send for review.
` : `STEP BY STEP

1. Make a Google Play developer account (once)
   • Go to play.google.com/console/signup and sign in with your Google account.
   • Choose “Yourself” (personal) or an organisation, pay the one-time US$25 fee and verify your identity.

2. Create the app
   • Play Console → Create app. App name: ${r.name}. Default language. App or game: App. Free or paid.
   • Accept the declarations → Create app.

3. Store listing
   • Grow users → Store presence → Main store listing.
   • Paste the texts from listing.txt and upload the pictures from store-listing/.
   • Pick a category and add your contact email.

4. Privacy policy
   • Put privacy-policy.html online so it has a web address. Free ways: Google Sites (paste the text into a page),
     or GitHub Pages (upload the file to a repository and turn on Pages).
   • Policy and programs → App content → Privacy policy → paste the address.

5. App content
   • Fill in App access, Ads, Content rating, Target audience and Data safety, using data-safety.txt.

6. Test the app (required for new personal accounts)
   • Personal developer accounts created after 13 November 2023 must run a closed test with at least 12 testers,
     who stay opted in for 14 days in a row, before they can publish to everyone. (Organisation accounts skip this.)
   • Test and release → Testing → Closed testing → Create track → Create new release.
   • Upload ${r.aabName}. Play App Signing is turned on for you: Google keeps the app signing key, and you sign
     uploads with your upload key (zenvqo did this already).
   • Add testers (an email list or a Google Group), save, and send for review. Share the opt-in link with your testers.

7. Publish to everyone
   • After the 14 days: Dashboard → Apply for production access, and answer the questions about your test.
   • When it's approved: Test and release → Production → Create new release → upload the .aab (or promote the
     tested release) → Send for review. Reviews usually take a few days.

UPDATING THE APP LATER
• In zenvqo, make the Google Play package again with the same package name (${r.pkg}).
  zenvqo raises the version code and signs it with the same upload key. Upload the new .aab in a new release.
`}
The package name (${r.pkg}) can never be changed after the first upload.
`;
}

/* ---------------- attached APKs ---------------- */

/** An APK made from a web page (by zenvqo or a similar app maker): its page and launcher icon. null for other APKs. */
export async function apkWebApp(bytes: Uint8Array): Promise<{ html: string; icon: string | null } | null> {
  const z = new Zip(bytes);
  const html = await z.text("assets/index.html");
  if (!html || !/<[a-z!]/i.test(html)) return null;
  const icons = z.find(/^res\/[^/]*\/ic_launcher[^/]*\.png$/i).sort((a, b) => b.size - a.size);
  let icon: string | null = null;
  const b = icons[0] ? await z.bytes(icons[0]) : null;
  if (b) {
    let bin = "";
    for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
    icon = "data:image/png;base64," + btoa(bin);
  }
  return { html, icon };
}

/* ---------------- building ---------------- */

export function makePlayPackage(input: PlayInput, onStep: (what: string) => void): Promise<PlayResult> {
  const b = window.ZenvqoPlay;
  if (!b) return Promise.reject(new Error(playAvailable().reason));
  if (!window.__zplay) window.__zplay = (id, ev, data) => handlers.get(id)?.(ev, data);
  const id = "p" + ++seq + "_" + Date.now();
  const facts = pageFacts(input.html);
  const update = hasUploadKey(input.pkg);
  const folder = input.name.replace(/[^A-Za-z0-9 _-]/g, "").trim().replace(/ +/g, "-") || "app";
  const files = {
    "listing.txt": listingText(input.name, input.short, input.full, input.email, input.website),
    "privacy-policy.html": privacyPolicy(input.name, input.email, facts),
    "data-safety.txt": dataSafety(input.name, facts),
    "HOW-TO-PUBLISH.txt": howToPublish({ name: input.name, pkg: input.pkg, aabName: `${folder}.aab`, versionCode: input.versionCode,
      versionName: input.versionName, update }),
  };
  return new Promise((resolve, reject) => {
    handlers.set(id, (ev, data) => {
      if (ev === "step") onStep(data);
      else if (ev === "done") { handlers.delete(id); resolve({ id, ...(JSON.parse(data) as Omit<PlayResult, "id">) }); }
      else if (ev === "error") { handlers.delete(id); reject(new Error(data)); }
    });
    b.make(id, JSON.stringify({ html: input.html, name: input.name, pkg: input.pkg, versionCode: input.versionCode, versionName: input.versionName,
      icon: input.icon, folder, files }));
  });
}
