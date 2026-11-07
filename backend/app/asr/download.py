"""Fetch the faster-whisper model named by ZC_ASR_MODEL (default "small") into the Hugging Face cache and test-load it.

    python -m app.asr.download
"""
import os
import sys
import time

if __name__ == "__main__":
    from faster_whisper import WhisperModel
    name = os.environ.get("ZC_ASR_MODEL", "small")
    t = time.monotonic()
    WhisperModel(name, device=os.environ.get("ZC_ASR_DEVICE", "cpu"), compute_type=os.environ.get("ZC_ASR_COMPUTE", "int8"))
    print(f"faster-whisper '{name}' ready ({time.monotonic() - t:.0f}s)")
    sys.exit(0)
