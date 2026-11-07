"""Turn an assistant reply into speakable sentences, and work out each sentence's language.

Languages: "en" (Latin script English), "hi" (Devanagari, including Devanagari mixed with English words — the usual
way Hindi replies carry technical terms), "hinglish" (Hindi written in Latin letters: "kal milte hain").
The frontend has the same logic in src/speech/text.ts so the standalone app can speak without a server.
"""
from __future__ import annotations

import re

MD = [(re.compile(r"```.*?```", re.S), " (code omitted) "), (re.compile(r"`([^`]*)`"), r"\1"),
      (re.compile(r"!\[[^\]]*\]\([^)]*\)"), " "), (re.compile(r"\[([^\]]+)\]\([^)]*\)"), r"\1"),
      (re.compile(r"https?://\S+"), " link "), (re.compile(r"^\s*#{1,6}\s*", re.M), ""),
      (re.compile(r"^\s*[-*•]\s+", re.M), ""), (re.compile(r"^\s*\d+[.)]\s+", re.M), ""),
      (re.compile(r"^\s*>\s?", re.M), ""), (re.compile(r"^\s*\|?\s*:?-{3,}.*$", re.M), ""),
      (re.compile(r"(\*\*|__|\*|_|~~)(\S(?:.*?\S)?)\1"), r"\2"), (re.compile(r"\s*\|\s*"), ", ")]
EMOJI = re.compile("[\U0001F000-\U0001FAFF☀-➿️]")
DEVA = re.compile(r"[ऀ-ॿ]")
ROMAN_HINDI = set("""hai hain nahi nahin kya kaise kaisa kaisi kyun kyon kyunki mera meri mere tum aap hum main mujhe
tera teri tumhara tumhari accha acha achha theek thik haan bhai yaar kar karo karna karte karta raha rahi rahe tha thi the
bahut bohot kuch abhi kal aaj matlab chalo ruko batao bolo dekho ghar kaam paisa paise ki ka ke ko se mein par aur bhi
toh to sab koi kaun kab kahan kitna kitne liye wala wali sakte sakta sakti hota hoti hote jaise agar lekin""".split())


TEX_WORDS = [(r"\\sqrt\s*\{([^{}]*)\}", r" square root of \1 "),
             (r"\^\s*\{?2\}?", " squared "), (r"\^\s*\{?3\}?", " cubed "), (r"\^\s*\{([^{}]*)\}", r" to the power \1 "),
             (r"\^\s*(\w)", r" to the power \1 "), (r"_\s*\{([^{}]*)\}", r" sub \1 "),
             (r"\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}", r" \1 over \2 "), (r"\\[dt]?frac\s*(\w)(\w)", r" \1 over \2 "), (r"\\(times|cdot)", " times "),
             (r"\\pm", " plus or minus "), (r"\\approx", " approximately "), (r"\\infty", " infinity "), (r"\\sum", " the sum of "),
             (r"\\int", " the integral of "), (r"\\(alpha|beta|gamma|delta|theta|lambda|mu|pi|sigma|phi|omega)\b", r" \1 "),
             (r"=", " equals "), (r"\+", " plus "), (r"(?<=[\s\w])-(?=[\s\w])", " minus "),
             (r"\\(left|right|mathrm|text|mathbf|displaystyle|,|;|!|quad|qquad)", " "), (r"[{}\\]", " ")]


def tex_to_speech(tex: str) -> str:
    t = f" {tex} "
    for rx, rep in TEX_WORDS:
        t = re.sub(rx, rep, t)
    return " ".join(t.split())


def speakable(text: str) -> str:
    t = text or ""
    t = re.sub(r"\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)", lambda m: f" {tex_to_speech(m.group(1) or m.group(2) or m.group(3))} ", t)
    t = re.sub(r"(^|[^\\$\w])\$(?=\S)([^$\n]+?)(?<=\S)\$(?!\d)",
               lambda m: m.group(0) if re.fullmatch(r"\d+([.,]\d+)?", m.group(2)) else m.group(1) + tex_to_speech(m.group(2)), t)
    for rx, rep in MD:
        t = rx.sub(rep, t)
    t = EMOJI.sub("", t)
    t = re.sub(r"₹\s?([\d,]+(?:\.\d+)?)", r"\1 rupees", t).replace("₹", " rupees ")
    t = t.replace("&", " and ").replace("%", " percent")
    lines = [" ".join(line.split()) for line in t.split("\n")]
    return "\n".join(line for line in lines if line.strip(" ,"))


SENT = re.compile(r"(?<=[.!?।॥])[\"'”’)]*\s+|\n+")


def sentences(text: str, max_chars: int = 240, min_chars: int = 30) -> list[str]:
    """Split into sentences; break very long ones at commas/spaces; join tiny fragments to their neighbour."""
    out: list[str] = []
    for s in (x.strip() for x in SENT.split(speakable(text)) if x and x.strip()):
        while len(s) > max_chars:
            cut = max(s.rfind(", ", 0, max_chars), s.rfind("; ", 0, max_chars))
            if cut < max_chars // 3:
                cut = s.rfind(" ", 0, max_chars)
            cut = cut if cut > 0 else max_chars
            out.append(s[:cut + 1].strip())
            s = s[cut + 1:].strip()
        if not s:
            continue
        if out and len(out[-1]) < min_chars and len(out[-1]) + len(s) < max_chars and detect_lang(out[-1]) == detect_lang(s):
            out[-1] = f"{out[-1]} {s}"
        else:
            out.append(s)
    return out


def detect_lang(text: str) -> str:
    deva = len(DEVA.findall(text))
    latin = sum(1 for c in text if c.isascii() and c.isalpha())
    if deva and deva >= 0.15 * (deva + latin):
        return "hi"
    words = re.findall(r"[a-z]+", text.lower())
    if len(words) >= 2 and sum(w in ROMAN_HINDI for w in words) / len(words) >= 0.3:
        return "hinglish"
    return "en"
