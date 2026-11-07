"""Turn a chat message into an image plan.

Two routes produce the same Plan:
  • rules  — fast pattern matching for clear requests ("generate an image of…", "remove the background", Hinglish too)
  • tools  — the chat model calls generate_image / edit_image (OpenAI-style function calling) for anything subtler
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from .spec import ASPECTS, OPS, STYLE_ALIASES, STYLES, norm_style


@dataclass
class Plan:
    op: str
    prompt: str = ""
    style: str | None = None
    aspect_ratio: str | None = None
    resolution: int | None = None
    n: int | None = None
    seed: int | None = None
    negative_prompt: str | None = None
    output_format: str | None = None
    background: str = ""
    image_ref: str = "latest"                # "attached" | "latest" | "#3" | a file id
    clarify: str | None = None               # ask the user this instead of running
    via: str = "rules"
    extras: dict = field(default_factory=dict)


NUM = {"one": 1, "two": 2, "three": 3, "four": 4, "ek": 1, "do": 2, "teen": 3, "char": 4, "chaar": 4}
NOUNS = r"(image|images|picture|pictures|pic|pics|photo|photos|photograph|logo|logos|portrait|illustration|poster|wallpaper|artwork|art|drawing|painting|icon|sticker|banner|thumbnail|avatar|render|sketch|meme|tasveer|tasvir|chitra|foto)"
GEN_VERB = r"(generate|create|make|draw|paint|design|render|sketch|produce|imagine|illustrate|banao|bana do|banado|bnao|bana de|banaiye)"
NOT_IMAGE = re.compile(r"\b(code|script|function|component|react|html|css|javascript|typescript|python|java|kotlin|program|website|web ?site|api|sql|"
                       r"database|regex|essay|email|story|poem|song|list|table|plan|summary|resume)\b|\b(image|picture|photo)\s+(gallery|viewer|editor|upload\w*|slider|carousel|folder|files?|compression|classifier|dataset)\b", re.I)
QUESTION = re.compile(r"^\s*(how|what|why|which|when|where|who|explain|tell me about|kya|kaise|kyun)\b", re.I)
STYLE_WORDS = sorted(set(STYLES) - {"none"} | set(STYLE_ALIASES), key=len, reverse=True)
STYLE_RX = re.compile(r"\b(" + "|".join(re.escape(w).replace(r"\-", "[- ]?") for w in STYLE_WORDS) + r")\b", re.I)

RX = {
    "remove_bg": re.compile(
        r"\b(remove|erase|delete|cut ?out|get rid of|clear|hata\w*|nikal\w*)\s+(the\s+|its\s+|my\s+|this\s+)?(background|bg|backdrop)\b"
        r"|\b(background|bg)\s+(hatao|hata do|hata de|remove|nikalo|nikal do|hatana|delete|erase)\b"
        r"|\btransparent (background|bg)\b|\bbackground transparent\b|\bremove\s?bg\b|\bno background\b", re.I),
    "replace_bg": re.compile(
        r"\b(change|replace|swap|switch|set|make)\s+(the\s+|its\s+|my\s+|this\s+)?(background|bg|backdrop)\b(\s+(to|with|into|as|for|of))?\s*(?P<bg>[^.?!]*)"
        r"|\b(background|bg)\s+(to|with|into)\s+(?P<bg2>[^.?!]+)"
        r"|\b(put|place)\s+(him|her|it|them|me|this|that|the \w+)\s+(on|in|at|against)\s+(?P<bg3>[^.?!]+)"
        r"|\b(?P<bg4>[\w\s,-]{2,60}?)\s+(ka|ki|wala)\s+(background|bg)\s+(lagao|laga do|daalo|kar do|karo)\b"
        r"|\b(background|bg)\s+(badlo|badal do|change karo|change kar do)\b", re.I),
    "remove_obj": re.compile(
        r"\b(remove|erase|delete|get rid of|take out|take away|hide|hata do|hatao|hata de|mita do)\s+(the\s+|that\s+|this\s+|those\s+|these\s+|a\s+|an\s+)?(?P<obj>[\w\s'-]{2,50}?)(\s+(from|in|on)\s+(the|this|my)\s+(image|photo|picture|pic))?\s*$", re.I),
    "variations": re.compile(r"\b(variations?|another version|more versions|other versions|different versions?|similar (ones?|images?)|more like (this|that|it)|alternatives?|re-?roll)\b", re.I),
    "style": re.compile(r"\b(make|turn|convert|redraw|render|change|transform|bana\w*|kar\w*)\b.*\b(" + "|".join(re.escape(w) for w in STYLE_WORDS) + r")\b", re.I),
    "edit": re.compile(r"^\s*(now\s+|also\s+|and\s+|ok\s+|okay\s+|please\s+|can you\s+|could you\s+)*(make|change|add|turn|put|give|replace|edit|adjust|brighten|darken|colou?r|fix|let|place|move|swap|convert)\b"
                       r"|\b(make it|make the|change (it|the|this)|add (a|an|some|the)|edit (it|this|the)|in (the|this) (image|photo|picture)|isko|ise|isme)\b", re.I),
    "gen": re.compile(rf"\b{GEN_VERB}\b.*\b{NOUNS}\b|\b{NOUNS}\b.*\b{GEN_VERB}\b|^\s*(an?\s+)?(image|picture|photo|drawing|painting|illustration|render) of\b|^\s*(draw|paint|sketch|illustrate|imagine)\b|\btext[- ]to[- ]image\b", re.I),
    "image_word": re.compile(rf"\b({NOUNS}|it|this|that|the one|isko|ise|isme|use)\b", re.I),
}


def extract_params(text: str) -> dict:
    t = text.lower()
    p: dict = {}
    m = re.search(r"\b(\d{1,2})\s*[:x×]\s*(\d{1,2})\b", t)
    if m and f"{m.group(1)}:{m.group(2)}" in ASPECTS:
        p["aspect_ratio"] = f"{m.group(1)}:{m.group(2)}"
    elif re.search(r"\b(phone wallpaper|mobile wallpaper|story|reel|vertical|tall)\b", t):
        p["aspect_ratio"] = "9:16"
    elif re.search(r"\bportrait (orientation|mode|format)\b|\bin portrait\b", t):
        p["aspect_ratio"] = "2:3"
    elif re.search(r"\b(landscape|horizontal|widescreen|wide|desktop wallpaper|youtube thumbnail|thumbnail|banner)\b", t):
        p["aspect_ratio"] = "16:9"
    elif re.search(r"\b(square|instagram post|profile picture|avatar|logo|icon)\b", t):
        p["aspect_ratio"] = "1:1"
    m = re.search(r"\b(\d|one|two|three|four|ek|do|teen|chaar|char)\s+(images|pictures|pics|photos|variations|versions|options|logos|ideas|designs|wallpapers|portraits|alag)\b", t)
    if m:
        p["n"] = int(NUM.get(m.group(1), m.group(1)) if not m.group(1).isdigit() else m.group(1))
    m = re.search(r"\bseed\s*(?:=|:|of|#)?\s*(\d{1,10})\b", t)
    if m:
        p["seed"] = int(m.group(1))
    if re.search(r"\b(4k|2k|hd|high[- ]?res(olution)?|1024|detailed large)\b", t):
        p["resolution"] = 1024
    elif re.search(r"\b768\b", t):
        p["resolution"] = 768
    elif re.search(r"\b(quick|fast|small|draft|512)\b", t):
        p["resolution"] = 512
    m = re.search(r"\b(?:as|in|to|format)\s+(?:a\s+)?(png|jpe?g|webp)\b|\b(png|jpe?g|webp)\s+(?:format|file)\b", t)
    if m:
        p["output_format"] = (m.group(1) or m.group(2)).replace("jpg", "jpeg")
    m = re.search(r"\bnegative(?: prompt)?\s*[:=]\s*([^.;\n]+)|\bavoid(?:ing)?\s+([^.;\n]+)", t)
    if m:
        p["negative_prompt"] = (m.group(1) or m.group(2)).strip()
    m = STYLE_RX.search(t)
    if m:
        p["style"] = norm_style(m.group(1).replace(" ", "-") if m.group(1).replace(" ", "-") in STYLES else m.group(1))
    return p


STRIP_PARAMS = [
    r"\b(in|at|with)?\s*(\d{1,2})\s*[:x×]\s*(\d{1,2})( aspect( ratio)?)?\b", r"\bseed\s*(=|:|of|#)?\s*\d+\b",
    r"\b(as|in)\s+(a\s+)?(png|jpe?g|webp)( format| file)?\b", r"\bnegative(?: prompt)?\s*[:=][^.;\n]+",
    r"\b(\d|one|two|three|four)\s+(images|pictures|pics|photos|variations|versions|options|ideas|designs)\b",
    r"\b(in )?(hd|4k|2k|high[- ]?res(olution)?)\b", r"\bin (landscape|portrait|square)( (orientation|mode|format))?\b",
]
LEAD = re.compile(
    r"^\s*(hey|hi|ok|okay|please|pls|plz|kindly)?[\s,]*(can|could|would|will)?\s*(you)?\s*(please|pls)?\s*"
    rf"{GEN_VERB}?\s*(me|us)?\s*(an?|the|some|ek)?\s*"
    r"((high[- ]quality|hd|quick|simple|nice|cool|beautiful|stunning|detailed|new|ai)\s+)*"
    r"((image|picture|pic|photo|photograph|illustration|drawing|painting|render|artwork|art)s?\s*(of|showing|with|that shows|depicting|for)?\s*)?", re.I)
TAIL_HI = re.compile(r"\s*(ki|ka|ke)?\s*(ek\s+)?(image|photo|picture|tasveer|tasvir|foto|pic)?\s*(banao|bana do|banado|bnao|bana de|banaiye|chahiye|do)\s*$", re.I)


def clean_prompt(text: str) -> str:
    t = text.strip()
    for rx in STRIP_PARAMS:
        t = re.sub(rx, " ", t, flags=re.I)
    t = TAIL_HI.sub("", t)
    t = LEAD.sub("", t, count=1)
    t = re.sub(r",\s*(in\s+)?(an?\s+)?(" + "|".join(re.escape(w) for w in STYLE_WORDS) + r")(\s+style)?\s*(?=,|$)", "", t, flags=re.I)
    t = re.sub(r"\s+", " ", t).strip(" ,.;:!-")
    return t or text.strip()


EDIT_LEAD = re.compile(r"^\s*((now|also|and|ok|okay|please|pls|can you|could you)\s+)*(make|turn|change|convert|edit|render|redraw|transform)\s+"
                       r"(it|this|that|the (image|photo|picture|pic)|the whole thing|everything)?\s*(into|to|look|be|in|as|more)?\s*(like\s+)?(an?\s+)?", re.I)


def clean_edit(text: str) -> str:
    t = EDIT_LEAD.sub("", text.strip(), count=1)
    for rx in STRIP_PARAMS:
        t = re.sub(rx, " ", t, flags=re.I)
    t = re.sub(r"\s+", " ", t).strip(" ,.;:!-")
    return t or text.strip()


def _ref(text: str, attached: bool) -> str:
    if attached:
        return "attached"
    m = re.search(r"(?:image|picture|photo|pic|#)\s*#?(\d{1,2})\b", text, re.I)
    if m:
        return "#" + m.group(1)
    for word, k in (("first", 1), ("second", 2), ("third", 3)):
        if re.search(rf"\b{word} (one|image|picture|photo)\b", text, re.I):
            return f"#{k}"
    return "latest"


def detect(text: str, *, attached_image: bool, has_images: bool, last_reply_has_image: bool) -> Plan | None:
    """Rules route. Returns None when the message isn't clearly an image request."""
    t = " ".join(text.split())
    if not t or len(t) > 1500:
        return None
    params = extract_params(t)
    can_edit = attached_image or has_images
    ref = _ref(t, attached_image)
    about_image = attached_image or last_reply_has_image or bool(RX["image_word"].search(t))

    def plan(op, prompt="", **kw):
        return Plan(op=op, prompt=prompt, image_ref=ref, **{**params, **kw})

    if can_edit and about_image and RX["remove_bg"].search(t):
        return plan("remove_background")
    m = RX["replace_bg"].search(t) if can_edit and about_image else None
    if m:
        bg = next((g for g in (m.group("bg"), m.group("bg2"), m.group("bg3"), m.group("bg4")) if g and g.strip()), "")
        bg = re.sub(r"^(a|an|the)\s+", "", bg.strip(" ,.")).strip()
        if not bg:
            return plan("replace_background", clarify="What should the new background be? For example: “a beach at sunset” or “plain white”.")
        return plan("replace_background", prompt=bg, background=bg)
    if QUESTION.search(t) and not RX["gen"].search(t.split("?")[-1] or ""):
        return None
    if can_edit and (attached_image or last_reply_has_image) and RX["variations"].search(t):
        return plan("variations", n=params.get("n", 3))
    m = RX["remove_obj"].search(t)
    if m and can_edit and (attached_image or last_reply_has_image) and not RX["gen"].search(t):
        obj = re.sub(r"\b(from|in) (the|this|my) (image|photo|picture|pic)\b", "", m.group("obj")).strip()
        if obj and not re.fullmatch(r"(it|this|that|them)", obj, re.I):
            return plan("remove_object", prompt=obj)
    if can_edit and (attached_image or last_reply_has_image) and RX["style"].search(t) and params.get("style") \
            and not RX["gen"].search(t.replace(" it ", " ")) and len(t) < 120:
        return plan("style", prompt=clean_edit(t))
    gen_hit = RX["gen"].search(t) and not (NOT_IMAGE.search(t) and not re.search(r"\b(image|picture|photo|drawing|painting) of\b", t, re.I))
    if gen_hit and not (attached_image and RX["edit"].search(t) and not re.search(r"\b(new|another|fresh)\b", t, re.I)):
        if re.search(r"\blogo\b", t, re.I) and "style" not in params:
            params["style"] = "logo"
        prompt = clean_prompt(t)
        if len(prompt) < 3:
            return plan("generate", clarify="What should the image show?")
        return Plan(op="generate", prompt=prompt, image_ref=ref, **params)
    if can_edit and (attached_image or last_reply_has_image) and RX["edit"].search(t):
        return plan("edit", prompt=clean_edit(t))
    return None


# ---------------- tool route ----------------
TOOLS = [
    {"type": "function", "function": {
        "name": "generate_image",
        "description": "Create new images from a text description. Use for any request to draw, design, make or generate "
                       "a picture, photo, logo, poster, wallpaper, portrait, icon or illustration.",
        "parameters": {"type": "object", "properties": {
            "prompt": {"type": "string", "description": "Detailed visual description in English: subject, setting, lighting, composition."},
            "style": {"type": "string", "enum": [s for s in STYLES]},
            "aspect_ratio": {"type": "string", "enum": list(ASPECTS)},
            "n": {"type": "integer", "minimum": 1, "maximum": 4, "description": "How many images"},
            "seed": {"type": "integer"},
            "negative_prompt": {"type": "string", "description": "Things to keep out of the image"},
        }, "required": ["prompt"]}}},
    {"type": "function", "function": {
        "name": "edit_image",
        "description": "Change an existing image: one the user attached or one generated earlier in this chat.",
        "parameters": {"type": "object", "properties": {
            "operation": {"type": "string", "enum": [o for o in OPS if o != "generate"],
                          "description": "edit = change by instruction; style = restyle; variations = similar new versions; "
                                         "remove_object; remove_background (transparent cut-out); replace_background; "
                                         "inpaint = change only the masked area"},
            "instruction": {"type": "string", "description": "What to change, or the object to remove, in English"},
            "image": {"type": "string", "description": "'latest', 'attached', or '#N' for image number N in this chat"},
            "style": {"type": "string", "enum": [s for s in STYLES]},
            "background": {"type": "string", "description": "New background for replace_background"},
            "n": {"type": "integer", "minimum": 1, "maximum": 4},
        }, "required": ["operation"]}}},
]


def plan_from_tool(name: str, args: dict) -> Plan | None:
    if name == "generate_image":
        prompt = str(args.get("prompt", "")).strip()
        if not prompt:
            return None
        return Plan("generate", prompt, style=args.get("style"), aspect_ratio=args.get("aspect_ratio"), n=args.get("n"),
                    seed=args.get("seed"), negative_prompt=args.get("negative_prompt"), via="tool")
    if name == "edit_image":
        op = args.get("operation") or "edit"
        if op not in OPS or op == "generate":
            op = "edit"
        instr = str(args.get("instruction", "")).strip()
        bg = str(args.get("background", "")).strip()
        return Plan(op, instr or bg, style=args.get("style"), n=args.get("n"), background=bg,
                    image_ref=str(args.get("image") or "latest"), via="tool")
    return None
