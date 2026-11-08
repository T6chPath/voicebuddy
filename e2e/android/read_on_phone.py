"""On the emulator: take a photo with the in-app camera and read a PDF in the chat (pdf.js on the phone's WebView).

Run after pdf_on_phone.py (the app is already open). Usage: python read_on_phone.py OUT_DIR
"""
import base64
import subprocess
import time

from pdf_on_phone import OUT, Page, ask, page_socket


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
    print("OK: in-app camera works and PDFs are read on the phone")


if __name__ == "__main__":
    main()
