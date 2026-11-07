"""Download the Kokoro-82M ONNX model and voice pack (≈340 MB) from the kokoro-onnx GitHub release.

    python -m app.tts.download            # into ~/.cache/zenvqo/kokoro (or $ZC_KOKORO_DIR)
"""
from __future__ import annotations

import os
import sys
import urllib.request
from pathlib import Path

BASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"
FILES = ["kokoro-v1.0.onnx", "voices-v1.0.bin"]


def main() -> int:
    d = Path(os.environ.get("ZC_KOKORO_DIR", Path.home() / ".cache" / "zenvqo" / "kokoro"))
    d.mkdir(parents=True, exist_ok=True)
    for name in FILES:
        dest = d / name
        if dest.is_file() and dest.stat().st_size > 1_000_000:
            print(f"{name}: already there")
            continue
        print(f"{name}: downloading…", flush=True)
        tmp = dest.with_suffix(".part")
        urllib.request.urlretrieve(BASE + name, tmp)
        tmp.replace(dest)
        print(f"{name}: {dest.stat().st_size / 1e6:.0f} MB")
    print("Kokoro ready in", d)
    return 0


if __name__ == "__main__":
    sys.exit(main())
