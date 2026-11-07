"""Request-side safety checks that run before any provider is called.

Hosted providers (Gemini, OpenAI) add their own moderation on top; their refusals are mapped to SafetyBlocked too.
The local model has no built-in filter, so these checks plus the optional output classifier (local.py) are what
stands between a prompt and a picture there. Matching is intentionally conservative: it blocks clear cases and
leaves nuance to the hosted moderation and to operators."""
from __future__ import annotations

import re


class SafetyBlocked(ValueError):
    pass


_MINOR = r"(child|children|kid|kids|minor|minors|underage|under-age|teen|teenage|teenager|preteen|schoolgirl|schoolboy|toddler|baby|infant|loli|shota|\d\s*-?\s*(?:yo|year[s]?[- ]old)|young girl|young boy|little girl|little boy)"
_SEXUAL = r"(nude|naked|nsfw|sexual|sexy|porn|pornographic|erotic|explicit|lingerie|topless|undress|undressed|stripper|genitals?|nipples|sex)"
_UNDRESS = r"(undress|remove (her|his|their|the) (clothes|clothing|shirt|dress|top|bra)|take off (her|his|their) (clothes|clothing)|make (her|him|them) (naked|nude)|nudify|x-?ray (her|him|them))"
_GORE = r"(dismember\w*|decapitat\w*|beheading|disembowel\w*|mutilat\w*|gore|gory|torture)"
_EXTREMISM = r"(swastika|isis flag|nazi propaganda|terrorist propaganda)"

RULES: list[tuple[str, re.Pattern, str]] = [
    ("minor_sexual", re.compile(rf"\b{_MINOR}\b.*\b{_SEXUAL}\b|\b{_SEXUAL}\b.*\b{_MINOR}\b", re.I | re.S),
     "I can't create sexual or suggestive images involving minors."),
    ("sexual", re.compile(rf"\b{_SEXUAL}\b", re.I), "I can't create sexual or nude images."),
    ("gore", re.compile(rf"\b{_GORE}\b", re.I), "I can't create graphic violence or gore."),
    ("extremism", re.compile(rf"\b{_EXTREMISM}\b", re.I), "I can't create extremist propaganda."),
]


def check_prompt(text: str, *, editing_photo: bool = False) -> None:
    """Raise SafetyBlocked with a user-facing reason if the request is not allowed."""
    t = " ".join((text or "").split())
    if editing_photo and re.search(_UNDRESS, t, re.I):
        raise SafetyBlocked("I can't remove clothing from or sexualise a photo of a person.")
    for _code, rx, msg in RULES:
        if rx.search(t):
            raise SafetyBlocked(msg)
