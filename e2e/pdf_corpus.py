"""Hard PDFs for the reading tests: each one is a kind that real people send and that simple readers get wrong.

    python e2e/pdf_corpus.py OUT_DIR      → writes the files and prints what each one checks
"""
import io
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def font(size):
    for f in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf"):
        if Path(f).exists():
            return ImageFont.truetype(f, size)
    return ImageFont.load_default()


def page_picture(lines, w=1240, h=1754):
    im = Image.new("RGB", (w, h), "white")
    d = ImageDraw.Draw(im)
    for i, line in enumerate(lines):
        d.text((100, 150 + i * 110), line, fill="black", font=font(64))
    return im


def raw_pdf(objects, root=1):
    """Write numbered objects (str or (dict_str, stream_bytes)) into a PDF with a correct xref."""
    out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offs = []
    for i, o in enumerate(objects, 1):
        offs.append(len(out))
        if isinstance(o, tuple):
            head, data = o
            out += f"{i} 0 obj\n{head[:-2]} /Length {len(data)} >>\nstream\n".encode() + data + b"\nendstream\nendobj\n"
        else:
            out += f"{i} 0 obj\n{o}\nendobj\n".encode()
    x = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode() + b"".join(f"{o:010d} 00000 n \n".encode() for o in offs)
    out += f"trailer\n<< /Size {len(objects) + 1} /Root {root} 0 R >>\nstartxref\n{x}\n%%EOF\n".encode()
    return bytes(out)


def image_page_pdf(img: Image.Image, filt: str) -> bytes:
    buf = io.BytesIO()
    if filt == "JPXDecode":
        img.save(buf, "JPEG2000", quality_mode="rates", quality_layers=[20])
    else:
        img.save(buf, "JPEG", quality=85)
    w, h = img.size
    content = f"q 595 0 0 842 0 0 cm /Im0 Do Q".encode()
    return raw_pdf([
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /XObject << /Im0 5 0 R >> >> >>",
        ("<< >>", content),
        (f"<< /Type /XObject /Subtype /Image /Width {w} /Height {h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /{filt} >>", buf.getvalue()),
    ])


def text_pdf(lines, font_obj="<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>") -> bytes:
    body = "BT /F1 16 Tf 72 760 Td " + " ".join(f"({l}) Tj 0 -26 Td" for l in lines) + " ET"
    return raw_pdf([
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        ("<< >>", body.encode("latin-1")),
        font_obj,
    ])


def build(out: Path, browser=None):
    """Returns {file name: (expected text the AI must receive, needs a page picture?)}."""
    out.mkdir(parents=True, exist_ok=True)
    cases = {}

    # 1. JPEG 2000 scan (common in scanners and government PDFs) — needs the OpenJPEG decoder
    (out / "scan-jpeg2000.pdf").write_bytes(image_page_pdf(page_picture(["JPX SCAN 314"]), "JPXDecode"))
    cases["scan-jpeg2000.pdf"] = ("It is scanned", True)

    # 2. Japanese text in a non-embedded CID font — needs Adobe CMaps to turn codes into characters
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.pdfgen import canvas
    pdfmetrics.registerFont(UnicodeCIDFont("HeiseiMin-W3"))
    c = canvas.Canvas(str(out / "japanese-cid.pdf"))
    c.setFont("HeiseiMin-W3", 20)
    c.drawString(72, 760, "日本語のテキスト 東京タワー")
    c.setFont("Helvetica", 14)
    c.drawString(72, 720, "Tokyo tower note")
    c.save()
    cases["japanese-cid.pdf"] = ("東京タワー", False)

    # 3. password-protected (user password "zen123")
    from pypdf import PdfReader, PdfWriter
    plain = out / "_plain.pdf"
    plain.write_bytes(text_pdf(["Locked report", "The vault code is 4471."]))
    w = PdfWriter(clone_from=PdfReader(plain))
    w.encrypt(user_password="zen123", owner_password="owner999", algorithm="AES-256")
    with open(out / "password-zen123.pdf", "wb") as f:
        w.write(f)
    cases["password-zen123.pdf"] = ("The vault code is 4471", False)

    # 4. owner-password only (opens without asking, printing/copying "restricted")
    w = PdfWriter(clone_from=PdfReader(plain))
    w.encrypt(user_password="", owner_password="owner999", algorithm="RC4-128")
    with open(out / "restricted.pdf", "wb") as f:
        w.write(f)
    cases["restricted.pdf"] = ("The vault code is 4471", False)

    # 5. mixed: page 1 typed text, page 2 a scanned picture
    w = PdfWriter()
    w.append(PdfReader(plain))
    (out / "_scan.pdf").write_bytes(image_page_pdf(page_picture(["SCANNED PAGE TWO"]), "DCTDecode"))
    w.append(PdfReader(out / "_scan.pdf"))
    with open(out / "mixed.pdf", "wb") as f:
        w.write(f)
    cases["mixed.pdf"] = ("The vault code is 4471", True)

    # 6. legacy Hindi font (Kruti Dev style): the text layer is Latin gibberish → must go as a picture too
    (out / "legacy-hindi-font.pdf").write_bytes(text_pdf(["Hkkjr dh jkt/kkuh ubZ fnYyh gS", "gekjk ns'k egku gS",
                                                          "fo|ky; esa i<+kbZ"]))
    cases["legacy-hindi-font.pdf"] = ("couldn't be decoded", True)

    # 7. damaged: xref table points nowhere (pdf.js must rebuild it)
    good = text_pdf(["Damaged but readable", "Recovered line 77."])
    bad = good[: good.rindex(b"xref")] + b"xref\n0 6\n0000000000 65535 f \n" + b"0000099999 00000 n \n" * 5 + good[good.rindex(b"trailer"):]
    (out / "damaged-xref.pdf").write_bytes(bad)
    cases["damaged-xref.pdf"] = ("Recovered line 77", False)

    # 8. junk before the header (emailed / downloaded files sometimes have it)
    (out / "junk-before-header.pdf").write_bytes(b"\r\n\xef\xbb\xbfHTTP junk line\r\n" + text_pdf(["Header after junk", "Junk test 55."]))
    cases["junk-before-header.pdf"] = ("Junk test 55", False)

    # 9. no .pdf name, wrong type from the file picker
    (out / "download").write_bytes(text_pdf(["Nameless file", "No extension 88."]))
    cases["download"] = ("No extension 88", False)

    # 10. filled-in form: the answers live in form fields, not in the page text
    from reportlab.lib.colors import white
    c = canvas.Canvas(str(out / "form-filled.pdf"))
    c.setFont("Helvetica", 14)
    c.drawString(72, 760, "Admission form")
    c.drawString(72, 720, "Student name:")
    c.acroForm.textfield(name="student_name", value="Asha Verma", x=200, y=712, width=200, height=20, fillColor=white)
    c.drawString(72, 680, "Roll number:")
    c.acroForm.textfield(name="roll_number", value="R-2047", x=200, y=672, width=200, height=20, fillColor=white)
    c.save()
    cases["form-filled.pdf"] = ("Asha Verma", False)

    # 11. Hindi (Unicode, embedded font) and a long multi-page document, made by Chromium
    if browser is not None:
        p = browser.new_page()
        p.set_content("<meta charset=utf-8><style>@page{size:A4;margin:20mm} body{font:13pt sans-serif} .b{break-before:page}</style>"
                      "<h1>भारत</h1><p>भारत की राजधानी नई दिल्ली है। गंगा सबसे लंबी नदी है।</p>"
                      + "".join(f"<div class=b><h2>Chapter {i}</h2><p>{'Lorem ipsum dolor sit amet. ' * 40}Fact {i}: the code is {1000 + i}.</p></div>"
                                for i in range(2, 61)))
        p.pdf(path=str(out / "hindi-and-long.pdf"), format="A4")
        p.close()
        cases["hindi-and-long.pdf"] = ("भारत की राजधानी नई दिल्ली है", False)

    for f in ("_plain.pdf", "_scan.pdf"):
        (out / f).unlink()
    return cases


if __name__ == "__main__":
    for name, (expect, picture) in build(Path(sys.argv[1] if len(sys.argv) > 1 else "pdf-corpus")).items():
        print(f"{name:28} expects {expect!r}{' + page picture' if picture else ''}")
