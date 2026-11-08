"""On the emulator: take a photo with the in-app camera and read a PDF in the chat (pdf.js on the phone's WebView).

Run after pdf_on_phone.py (the app is already open). Usage: python read_on_phone.py OUT_DIR
"""
import base64
import json
import subprocess
import sys
import time
from pathlib import Path

from pdf_on_phone import OUT, Page, ask, page_socket

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pdf_corpus import build  # noqa: E402

LAST_FILE = """(async () => {
  const db = await new Promise((ok, no) => { const r = indexedDB.open("zenvqo-chat"); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
  const rows = await new Promise((ok) => { const q = db.transaction("files").objectStore("files").getAll(); q.onsuccess = () => ok(q.result); });
  const f = rows.sort((a, b) => a.created_at - b.created_at).pop();
  let dark = -1;
  if (f.images && f.images.length) {
    const img = new Image(); img.src = f.images[0]; await img.decode();
    const c = document.createElement("canvas"); c.width = 400; c.height = 566;
    const x = c.getContext("2d"); x.drawImage(img, 0, 0, 400, 566);
    const d = x.getImageData(0, 0, 400, 566).data; dark = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < 450) dark++;
  }
  return JSON.stringify({ name: f.name, text: f.text || "", images: (f.images || []).length, dark });
})()"""


def inject(page, path, name):
    data = base64.b64encode(Path(path).read_bytes()).decode()
    page.js(f"""(() => {{
      const bytes = Uint8Array.from(atob("{data}"), c => c.charCodeAt(0));
      const dt = new DataTransfer(); dt.items.add(new File([bytes], {json.dumps(name)}, {{ type: "application/pdf" }}));
      const input = document.querySelector("form.composer input[type=file]"); input.files = dt.files;
      input.dispatchEvent(new Event("change", {{ bubbles: true }}));
    }})()""")


def hard_pdfs(page):
    """Each hard kind of PDF from e2e/pdf_corpus.py, read by the phone's own WebView with the APK's data files."""
    folder = OUT / "corpus"
    cases = build(folder)
    failures = []
    for name in ["scan-jpeg2000.pdf", "japanese-cid.pdf", "mixed.pdf", "legacy-hindi-font.pdf", "damaged-xref.pdf",
                 "junk-before-header.pdf", "form-filled.pdf", "password-zen123.pdf"]:
        expect, picture = cases[name]
        t0 = time.time()
        inject(page, folder / name, name)
        if name.startswith("password"):
            page.wait('!!document.querySelector(".pw-dialog input")', 30, "the password box")
            page.js('(() => { const i = document.querySelector(".pw-dialog input"); i.value = "zen123"; '
                    'document.querySelector(".pw-dialog").requestSubmit(); })()')
        page.wait(f'(() => {{ const c = [...document.querySelectorAll(".att-list.pending .chip")].find(c => c.innerText.includes({json.dumps(name)})); '
                  'return c && !c.querySelector("progress"); })()', 90, name)
        chip = page.js(f'[...document.querySelectorAll(".att-list.pending .chip")].find(c => c.innerText.includes({json.dumps(name)})).className')
        row = json.loads(page.js(LAST_FILE)) if "chip-error" not in chip else {"name": None}
        ok = "chip-error" not in chip and row["name"] == name and expect in row["text"] and (row["images"] > 0) == picture and (not picture or row["dark"] > 30)
        print(f"  {'OK ' if ok else 'BAD'} {name:26} {time.time() - t0:4.1f}s images={row.get('images')} dark={row.get('dark')} "
              f"text={row.get('text', '')[:90]!r}", flush=True)
        if not ok:
            failures.append(name)
        page.js(f'document.querySelector({json.dumps("[aria-label=" + json.dumps("Remove " + name) + "]")}).click()')
    assert not failures, failures


def tiny_pdf(lines):
    """A small text PDF written by hand (Helvetica), so the test needs no PDF library."""
    text = "BT /F1 18 Tf 72 760 Td " + " ".join(f"({l}) Tj 0 -28 Td" for l in lines) + " ET"
    objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
            f"<< /Length {len(text)} >>\nstream\n{text}\nendstream", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    out, offs = "%PDF-1.4\n", []
    for i, o in enumerate(objs, 1):
        offs.append(len(out))
        out += f"{i} 0 obj\n{o}\nendobj\n"
    x = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n" + "".join(f"{o:010d} 00000 n \n" for o in offs)
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{x}\n%%EOF\n"
    return out.encode("latin-1")


def shot(name):
    subprocess.run(f"adb exec-out screencap -p > {OUT}/{name}.png", shell=True)


PAINT = """(() => {
  const c = [...document.querySelectorAll("article.msg-assistant")].pop().querySelector(".plot canvas");
  if (!c) return null;
  const x = document.createElement("canvas"); x.width = 120; x.height = 90;
  const g = x.getContext("2d"); g.drawImage(c, 0, 0, 120, 90);
  const d = g.getImageData(0, 0, 120, 90).data; const seen = new Set(); let blue = 0;
  for (let i = 0; i < d.length; i += 4) { seen.add((d[i] >> 3) + "," + (d[i + 1] >> 3) + "," + (d[i + 2] >> 3)); if (d[i + 2] > 180 && d[i] < 90) blue++; }
  return JSON.stringify({ colours: seen.size, blue, readout: c.closest(".plot").querySelector(".plot-readout").innerText });
})()"""


def plots(page):
    """The demo draws graphs on the phone itself: a 2D function with its key points and a shaded 3D surface."""
    for prompt, check in [("plot y = x^2 - 4", lambda r: "Root (−2, 0)" in r["readout"] and r["blue"] > 40),
                          ("3d plot of sin(x) cos(y)", lambda r: r["colours"] > 150)]:
        ask(page, prompt)
        try:
            page.wait('(() => { const a = [...document.querySelectorAll("article.msg-assistant")].pop(); '
                      'return a && a.getAttribute("aria-busy") === "false" && a.querySelector(".plot canvas"); })()', 60, prompt)
        except SystemExit:
            shot("plot-failed")
            print("composer:", page.js('document.querySelector("#composer-input").value'))
            print("last messages:", page.js('[...document.querySelectorAll("article")].slice(-2).map(a => a.className + " busy=" + '
                                            'a.getAttribute("aria-busy") + " :: " + a.innerHTML.slice(0, 600)).join("\\n---\\n")'))
            raise
        time.sleep(1.5)
        r = json.loads(page.js(PAINT))
        ok = check(r)
        print(f"  {'OK ' if ok else 'BAD'} {prompt:28} colours={r['colours']} blue={r['blue']} readout={r['readout'][:80]!r}", flush=True)
        shot("plot-" + ("3d" if "3d" in prompt else "2d"))
        assert ok, prompt


def main():
    page = Page(page_socket())
    page.wait('!!document.querySelector("#composer-input")', 60, "the chat box")
    print("WebView:", page.js("navigator.userAgent"))

    # --- camera ---
    page.js('document.querySelector("[aria-label=\\"Take a photo\\"]").click()')
    t0 = time.time()
    try:
        page.wait('(() => { const b = document.querySelector("[aria-label=\\"Take photo\\"]"); return b && !b.disabled; })()', 30, "the live camera")
    except SystemExit:
        shot("camera-failed")
        print("camera dialog:", page.js('document.querySelector(".camera")?.innerText'))
        raise
    print(f"camera live after {time.time() - t0:.1f}s:", page.js('(() => { const v = document.querySelector(".camera video"); return v.videoWidth + "x" + v.videoHeight; })()'))
    time.sleep(1.5)
    shot("camera-live")
    page.js('document.querySelector("[aria-label=\\"Take photo\\"]").click()')
    page.wait('!!document.querySelector(".camera img")', 10, "the photo preview")
    shot("camera-preview")
    page.js('[...document.querySelectorAll(".camera button")].find(b => b.textContent === "Use photo").click()')
    page.wait('!!document.querySelector(".att-list.pending img.chip-thumb") && !document.querySelector(".att-list.pending progress")', 20, "the photo in the message")
    print("photo attached:", page.js('document.querySelector(".att-list.pending").innerText'))
    shot("camera-attached")
    page.js('document.querySelector("[aria-label^=\\"Remove photo\\"]").click()')

    # --- PDF read on the phone ---
    pdf = base64.b64encode(tiny_pdf(["Zenvqo phone test", "The secret word is pineapple."])).decode()
    page.js(f"""(() => {{
      const bytes = Uint8Array.from(atob("{pdf}"), c => c.charCodeAt(0));
      const dt = new DataTransfer(); dt.items.add(new File([bytes], "notes.pdf", {{ type: "application/pdf" }}));
      const input = document.querySelector("form.composer input[type=file]"); input.files = dt.files;
      input.dispatchEvent(new Event("change", {{ bubbles: true }}));
    }})()""")
    t0 = time.time()
    page.wait('(() => { const c = document.querySelector(".att-list.pending .chip"); return c && !c.querySelector("progress") && c.innerText; })()', 60, "the PDF to be read")
    chip = page.js('document.querySelector(".att-list.pending .chip").innerText')
    print(f"PDF read in {time.time() - t0:.1f}s:", chip)
    assert "chip-error" not in page.js('document.querySelector(".att-list.pending .chip").className'), chip
    ask(page, "What does the PDF say?")
    page.wait('(() => { const a = [...document.querySelectorAll("article.msg-assistant")].pop(); return a && a.getAttribute("aria-busy") === "false" && a.innerText.includes("First line"); })()', 60, "the demo's answer")
    reply = page.js('[...document.querySelectorAll("article.msg-assistant")].pop().innerText')
    print("reply:", reply[:400])
    shot("pdf-read")
    assert "a PDF with 1 page" in reply and "Zenvqo phone test" in reply, reply
    print("graphs on this phone:")
    plots(page)
    print("hard PDFs on this phone:")
    hard_pdfs(page)
    shot("hard-pdfs")
    print("OK: in-app camera works and PDFs are read on the phone")


if __name__ == "__main__":
    main()
