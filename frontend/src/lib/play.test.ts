import assert from "node:assert/strict";
import { test } from "node:test";
import { apkWebApp, dataSafety, draftListing, howToPublish, listingText, packageProblem, pageFacts, privacyPolicy, suggestPackage } from "../apk/play";
import { zip } from "./project";

test("package names: suggested from the app name, and Google Play's rules", () => {
  assert.equal(suggestPackage("Chai Shop!"), "com.chaishop.app");
  assert.equal(suggestPackage("2048 Game"), "com.game.app");
  assert.equal(suggestPackage("नमस्ते"), "com.myapp.app");
  assert.equal(packageProblem("com.chaishop.app"), "");
  assert.match(packageProblem("chaishop"), /two parts/);
  assert.match(packageProblem("com.1shop.app"), /start with a letter/);
  assert.match(packageProblem("com.new.app"), /reserved/);
  assert.match(packageProblem("com.example.shop"), /com\.example/);
  assert.match(packageProblem(""), /Enter/);
});

const PAGE = `<!doctype html><html><head><title>Chai Shop</title><meta name="description" content="Order fresh masala chai and snacks from your phone in seconds.">
<link href="https://fonts.googleapis.com/css2?family=Poppins" rel="stylesheet"></head><body>
<h1>Chai Shop</h1><h2>Masala chai</h2><h2>Fresh snacks</h2><h3>Fast delivery</h3>
<p>Our chai is brewed with fresh ginger, cardamom and whole milk every morning.</p>
<form><input placeholder="Your name"><textarea></textarea></form>
<script>localStorage.setItem("cart","[]")</script></body></html>`;

test("store texts: a draft from the page, within Play's limits", () => {
  const d = draftListing(PAGE, "Chai Shop");
  assert.equal(d.short, "Order fresh masala chai and snacks from your phone in seconds.");
  assert.ok(d.short.length <= 80 && d.full.length <= 4000);
  assert.match(d.full, /• Masala chai/);
  assert.match(d.full, /• Fast delivery/);
  const long = draftListing(`<p>${"word ".repeat(100)}</p>`, "X");
  assert.ok(long.short.length <= 80 && long.short.endsWith("…"));
});

test("what the page does → privacy policy and data-safety answers", () => {
  const f = pageFacts(PAGE);
  assert.equal(f.storage, true);
  assert.equal(f.forms, true);
  assert.equal(f.internet, true);                                       // loads a font from the internet
  assert.deepEqual(f.external, ["fonts.googleapis.com"]);
  assert.equal(f.camera || f.microphone || f.location, false);
  const offline = pageFacts("<h1>Notes</h1><script>localStorage.x=1</script>");
  assert.equal(offline.internet, false);
  assert.match(dataSafety("Notes", offline), /No\. The app keeps everything on the device/);
  assert.match(dataSafety("Chai Shop", f), /fonts\.googleapis\.com/);
  const policy = privacyPolicy("Chai <Shop>", "me@example.org", f, new Date("2026-11-12"));
  assert.match(policy, /Chai &lt;Shop&gt; — Privacy policy/);
  assert.match(policy, /mailto:me@example\.org/);
  assert.match(policy, /12 November 2026/);
  assert.match(policy, /stored only on your device/);
  assert.match(privacyPolicy("A", "", offline), /\[your email address\]/);
});

test("listing and guide", () => {
  const l = listingText("Chai Shop", "Short", "Full text", "", "");
  assert.match(l, /App name \(max 30 characters\):\nChai Shop/);
  const g = howToPublish({ name: "Chai Shop", pkg: "com.chaishop.app", aabName: "Chai-Shop.aab", versionCode: 1, versionName: "1.0", update: false });
  assert.match(g, /Chai-Shop\.aab/);
  assert.match(g, /12 testers/);
  assert.match(g, /API level 36/);
  assert.match(g, /US\$25/);
  const u = howToPublish({ name: "Chai Shop", pkg: "com.chaishop.app", aabName: "Chai-Shop.aab", versionCode: 4, versionName: "1.3", update: true });
  assert.match(u, /THIS IS AN UPDATE/);
  assert.match(u, /version code \(4\)/);
});

test("an APK made from a web page gives back its page and icon; other APKs don't", async () => {
  const web = zip([{ path: "AndroidManifest.xml", content: "x" }, { path: "assets/index.html", content: PAGE },
    { path: "res/mipmap-xxxhdpi-v4/ic_launcher.png", content: "PNGDATA" }, { path: "classes.dex", content: "dex" }]);
  const app = await apkWebApp(web);
  assert.ok(app);
  assert.match(app!.html, /Chai Shop/);
  assert.equal(app!.icon, "data:image/png;base64," + Buffer.from("PNGDATA").toString("base64"));
  const native = zip([{ path: "AndroidManifest.xml", content: "x" }, { path: "classes.dex", content: "dex" }]);
  assert.equal(await apkWebApp(native), null);
});
