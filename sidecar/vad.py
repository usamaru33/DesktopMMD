"""Streaming voice activity detection with Silero VAD v6 (ONNX).

The model consumes 512-sample (32 ms @16 kHz) chunks plus the previous 64 samples of context and carries
its LSTM state (h, c) between calls. See skill mmd-voice-pipeline §6.
"""
from __future__ import annotations

import os
from collections import deque
from dataclasses import dataclass, field

import numpy as np

SR = 16000
CHUNK = 512
CONTEXT = 64
CHUNK_SEC = CHUNK / SR


def default_model_path() -> str:
    import faster_whisper

    return os.path.join(os.path.dirname(faster_whisper.__file__), "assets", "silero_vad_v6.onnx")


class SileroStream:
    """Stateful per-chunk speech probability."""

    def __init__(self, model_path: str | None = None):
        import onnxruntime as ort

        opts = ort.SessionOptions()
        opts.inter_op_num_threads = 1
        opts.intra_op_num_threads = 1
        opts.log_severity_level = 4
        self.session = ort.InferenceSession(model_path or default_model_path(), providers=["CPUExecutionProvider"], sess_options=opts)
        self.reset()

    def reset(self) -> None:
        self.h = np.zeros((1, 1, 128), dtype=np.float32)
        self.c = np.zeros((1, 1, 128), dtype=np.float32)
        self.context = np.zeros(CONTEXT, dtype=np.float32)

    def prob(self, chunk: np.ndarray) -> float:
        assert chunk.shape == (CHUNK,)
        x = np.concatenate([self.context, chunk]).reshape(1, CHUNK + CONTEXT).astype(np.float32)
        out, self.h, self.c = self.session.run(None, {"input": x, "h": self.h, "c": self.c})
        self.context = chunk[-CONTEXT:].copy()
        return float(np.asarray(out).reshape(-1)[0])


@dataclass
class VadConfig:
    start_threshold: float = 0.5
    boosted_start_threshold: float = 0.65
    end_threshold: float = 0.35
    start_frames: int = 3  # ~100 ms
    end_silence_sec: float = 0.7
    preroll_sec: float = 0.3
    min_speech_sec: float = 0.4
    max_speech_sec: float = 30.0


@dataclass
class VadEvent:
    kind: str  # "start" | "end"
    t: float
    audio: np.ndarray | None = None  # for "end": the utterance (float32, 16 kHz)


@dataclass
class Segmenter:
    """Turns a stream of probabilities into utterances. Pure (no model) so it is unit-testable."""

    cfg: VadConfig = field(default_factory=VadConfig)
    boosted: bool = False
    t: float = 0.0
    in_speech: bool = False
    above: int = 0
    silence: float = 0.0
    speech_len: float = 0.0
    pre: deque = field(default_factory=deque)
    buf: list = field(default_factory=list)

    def reset(self) -> None:
        self.in_speech = False
        self.above = 0
        self.silence = 0.0
        self.speech_len = 0.0
        self.pre.clear()
        self.buf = []

    def feed(self, chunk: np.ndarray, p: float) -> list[VadEvent]:
        events: list[VadEvent] = []
        self.t += CHUNK_SEC
        thr = self.cfg.boosted_start_threshold if self.boosted else self.cfg.start_threshold
        if not self.in_speech:
            self.pre.append(chunk)
            max_pre = int(self.cfg.preroll_sec / CHUNK_SEC) + self.cfg.start_frames
            while len(self.pre) > max_pre:
                self.pre.popleft()
            self.above = self.above + 1 if p >= thr else 0
            if self.above >= self.cfg.start_frames:
                self.in_speech = True
                self.buf = list(self.pre)
                self.pre.clear()
                self.silence = 0.0
                self.speech_len = self.cfg.start_frames * CHUNK_SEC
                events.append(VadEvent("start", self.t))
            return events

        self.buf.append(chunk)
        self.speech_len += CHUNK_SEC
        if p < self.cfg.end_threshold:
            self.silence += CHUNK_SEC
        else:
            self.silence = 0.0
        if self.silence >= self.cfg.end_silence_sec or self.speech_len >= self.cfg.max_speech_sec:
            events.append(self._close())
        return events

    def _close(self) -> VadEvent:
        audio = np.concatenate(self.buf) if self.buf else np.zeros(0, dtype=np.float32)
        voiced = self.speech_len - self.silence
        self.reset()
        if voiced < self.cfg.min_speech_sec:
            return VadEvent("end", self.t, None)  # too short: discard
        return VadEvent("end", self.t, audio)

    def flush(self) -> VadEvent | None:
        """Push-to-talk release: close whatever is open."""
        if self.in_speech:
            return self._close()
        self.reset()
        return None


class StreamingVad:
    """Accepts arbitrary-length int16 PCM, re-chunks to 512 samples, runs Silero + Segmenter."""

    def __init__(self, model: SileroStream | None = None, cfg: VadConfig | None = None):
        self.model = model or SileroStream()
        self.seg = Segmenter(cfg or VadConfig())
        self.rest = np.zeros(0, dtype=np.float32)

    def reset(self) -> None:
        self.model.reset()
        self.seg.reset()
        self.rest = np.zeros(0, dtype=np.float32)

    def set_boost(self, on: bool) -> None:
        self.seg.boosted = on

    def push_pcm16(self, data: bytes) -> list[VadEvent]:
        x = np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0
        self.rest = np.concatenate([self.rest, x])
        events: list[VadEvent] = []
        while len(self.rest) >= CHUNK:
            chunk, self.rest = self.rest[:CHUNK], self.rest[CHUNK:]
            events.extend(self.seg.feed(chunk, self.model.prob(chunk)))
        return events

    def flush(self) -> VadEvent | None:
        return self.seg.flush()
