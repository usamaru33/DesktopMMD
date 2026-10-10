"""faster-whisper transcription with GPU→CPU fallback and hallucination filtering (spec 5.6)."""
from __future__ import annotations

import glob
import os
import re
import site
import sys
import time
from dataclasses import dataclass

import numpy as np

HALLUCINATIONS = [
    "ご視聴ありがとうございました",
    "ご視聴ありがとうございます",
    "チャンネル登録",
    "高評価",
    "字幕",
    "おやすみなさい。おやすみなさい",
    "ありがとうございました。ありがとうございました",
    "最後までご覧いただき",
    "次回もお楽しみに",
    "お疲れ様でした。お疲れ様でした",
]


def add_cuda_dll_dirs() -> list[str]:
    """pip's nvidia-* wheels put DLLs under site-packages/nvidia/*/bin; make them loadable on Windows."""
    added: list[str] = []
    if sys.platform != "win32":
        return added
    roots = list(site.getsitepackages()) + [site.getusersitepackages()]
    # PyInstaller build: DLLs are bundled under <_internal>/nvidia/*/bin
    if getattr(sys, "frozen", False):
        roots.insert(0, getattr(sys, "_MEIPASS", os.path.dirname(sys.executable)))
    for root in roots:
        for d in glob.glob(os.path.join(root, "nvidia", "*", "bin")):
            try:
                os.add_dll_directory(d)
                os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
                added.append(d)
            except OSError:
                pass
    return added


def is_hallucination(text: str) -> bool:
    t = re.sub(r"\s+", "", text)
    if not t:
        return True
    if any(h in t for h in HALLUCINATIONS):
        return True
    # one character repeated, or the same short phrase repeated many times
    if len(set(t)) <= 2 and len(t) >= 6:
        return True
    m = re.fullmatch(r"(.{1,8}?)\1{4,}", t)
    return bool(m)


@dataclass
class Transcript:
    text: str
    confidence: float
    duration_ms: int
    proc_ms: int


class Transcriber:
    def __init__(self, model_name: str = "large-v3-turbo", device: str = "auto", download_root: str | None = None):
        self.model = None
        self.device = "cpu"
        self.model_name = model_name
        self.download_root = download_root
        self.load_ms = 0
        self._load(model_name, device)

    def _load(self, name: str, device: str) -> None:
        add_cuda_dll_dirs()
        from faster_whisper import WhisperModel

        t0 = time.time()
        attempts: list[tuple[str, str, str]] = []
        if device in ("auto", "cuda"):
            attempts.append((name, "cuda", "float16"))
        if device in ("auto", "cpu"):
            # spec 2.2: small on CPU
            attempts.append(("small" if name.startswith("large") else name, "cpu", "int8"))
        last: Exception | None = None
        for model_name, dev, ctype in attempts:
            try:
                m = WhisperModel(model_name, device=dev, compute_type=ctype, download_root=self.download_root)
                # warm-up: forces CUDA libs to load now instead of on the first utterance
                list(m.transcribe(np.zeros(16000, dtype=np.float32), language="ja", beam_size=1)[0])
                self.model, self.device, self.model_name = m, dev, model_name
                self.load_ms = int((time.time() - t0) * 1000)
                return
            except Exception as e:  # noqa: BLE001 - try the next option
                last = e
                print(f"[stt] {model_name}/{dev} failed: {e}", file=sys.stderr, flush=True)
        raise RuntimeError(f"no usable whisper model: {last}")

    def transcribe(self, audio: np.ndarray, prompt: str = "") -> Transcript | None:
        assert self.model is not None
        t0 = time.time()
        segments, info = self.model.transcribe(
            audio,
            language="ja",
            beam_size=1,
            vad_filter=False,
            condition_on_previous_text=False,
            initial_prompt=prompt or None,
            without_timestamps=True,
        )
        segs = list(segments)
        proc_ms = int((time.time() - t0) * 1000)
        segs = [s for s in segs if s.no_speech_prob < 0.6]
        text = "".join(s.text for s in segs).strip()
        if is_hallucination(text):
            return None
        conf = float(np.exp(np.mean([s.avg_logprob for s in segs]))) if segs else 0.0
        return Transcript(text=text, confidence=conf, duration_ms=int(len(audio) / 16), proc_ms=proc_ms)
