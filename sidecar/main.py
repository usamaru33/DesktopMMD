"""DesktopMMD Python sidecar: VAD, speech-to-text and sentence embeddings over a local WebSocket.

Protocol: skill mmd-voice-pipeline §6. Started by the Electron main process:
    python -I sidecar/main.py --port 0 --token <random> [--models-dir DIR]
The first stdout line is {"port": N}. Only 127.0.0.1 is bound and the first message must carry the token.
"""
from __future__ import annotations

import argparse
import asyncio
import hmac
import json
import os
import sys
import time
import traceback
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import numpy as np  # noqa: E402
from websockets.asyncio.server import ServerConnection, serve  # noqa: E402

from vad import StreamingVad, VadConfig  # noqa: E402


def log(*a: object) -> None:
    print("[sidecar]", *a, file=sys.stderr, flush=True)


def trim_working_set() -> bool:
    """Release idle pages (CUDA/cuDNN DLLs, model loading buffers) back to the OS standby list (NFR-05).
    Touched again later they soft-fault back in quickly."""
    if sys.platform != "win32":
        return False
    try:
        import ctypes
        from ctypes import wintypes

        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.GetCurrentProcess.restype = wintypes.HANDLE
        k32.SetProcessWorkingSetSize.argtypes = [wintypes.HANDLE, ctypes.c_size_t, ctypes.c_size_t]
        k32.SetProcessWorkingSetSize.restype = wintypes.BOOL
        unlimited = ctypes.c_size_t(-1).value
        return bool(k32.SetProcessWorkingSetSize(k32.GetCurrentProcess(), unlimited, unlimited))
    except Exception:  # noqa: BLE001
        return False


class Sidecar:
    def __init__(self, token: str, models_dir: str | None):
        self.token = token
        self.models_dir = models_dir
        self.pool = ThreadPoolExecutor(max_workers=2)
        self.stt_pool = ThreadPoolExecutor(max_workers=1)
        self.stt = None
        self.embedder = None
        self.embed_ready = asyncio.Event()
        self.vad: StreamingVad | None = None
        self.listening = False
        self.mode = "vad"
        self.vocab: list[str] = []
        self.ws: ServerConnection | None = None
        self.loading = False
        self.last_activity = time.time()
        self.trimmed = False

    async def send(self, obj: dict) -> None:
        ws = self.ws
        if ws is None:
            return
        try:
            await ws.send(json.dumps(obj, ensure_ascii=False))
        except Exception:  # noqa: BLE001
            pass

    # ------------------------------------------------------------ loading

    async def load(self, cfg: dict) -> None:
        if self.loading:
            return
        self.loading = True
        loop = asyncio.get_running_loop()
        self.vad = StreamingVad(cfg=VadConfig())
        whisper_dir = os.path.join(self.models_dir, "whisper") if self.models_dir else None
        hf_dir = os.path.join(self.models_dir, "hf") if self.models_dir else None

        async def load_stt() -> None:
            from stt import Transcriber

            t0 = time.time()
            try:
                self.stt = await loop.run_in_executor(
                    self.stt_pool, lambda: Transcriber(cfg.get("sttModel", "large-v3-turbo"), cfg.get("device", "auto"), whisper_dir)
                )
                await self.send({"type": "ready", "component": "stt", "device": self.stt.device, "sttModel": self.stt.model_name, "loadMs": int((time.time() - t0) * 1000)})
            except Exception as e:  # noqa: BLE001
                log("stt load failed", e)
                await self.send({"type": "error", "component": "stt", "message": str(e)})

        async def load_embed() -> None:
            from embed import E5Embedder

            try:
                self.embedder = await loop.run_in_executor(self.pool, lambda: E5Embedder(hf_dir))
                self.embed_ready.set()
                await self.send({"type": "ready", "component": "embed", "dim": 384})
            except Exception as e:  # noqa: BLE001
                log("embed load failed", e)
                await self.send({"type": "error", "component": "embed", "message": str(e)})

        tasks = [asyncio.create_task(load_embed())]
        if cfg.get("stt", True):
            tasks.append(asyncio.create_task(load_stt()))
        await self.send({"type": "ready", "component": "vad"})
        await asyncio.gather(*tasks)
        self.touch()
        asyncio.create_task(self.idle_trimmer())

    # ------------------------------------------------------------ audio

    def touch(self) -> None:
        self.last_activity = time.time()
        self.trimmed = False

    async def idle_trimmer(self) -> None:
        while True:
            await asyncio.sleep(10)
            if not self.listening and not self.trimmed and time.time() - self.last_activity > 20:
                ok = trim_working_set()
                self.trimmed = True
                log(f"idle: working set trimmed ({'ok' if ok else 'failed'})")

    async def on_audio(self, data: bytes) -> None:
        self.touch()
        if not self.listening or self.vad is None:
            return
        for ev in self.vad.push_pcm16(data):
            await self.on_vad_event(ev)

    async def on_vad_event(self, ev) -> None:
        if ev.kind == "start":
            await self.send({"type": "speech_start", "t": ev.t})
        elif ev.kind == "end":
            await self.send({"type": "speech_end", "t": ev.t, "discarded": ev.audio is None})
            if ev.audio is not None:
                asyncio.create_task(self.transcribe(ev.audio))

    async def transcribe(self, audio: np.ndarray) -> None:
        if self.stt is None:
            await self.send({"type": "error", "component": "stt", "message": "not_ready"})
            return
        loop = asyncio.get_running_loop()
        prompt = "、".join(self.vocab[:50])
        try:
            r = await loop.run_in_executor(self.stt_pool, lambda: self.stt.transcribe(audio, prompt))
        except Exception as e:  # noqa: BLE001
            await self.send({"type": "error", "component": "stt", "message": str(e)})
            return
        if r is None:
            await self.send({"type": "transcript", "text": "", "discarded": True})
            return
        await self.send({"type": "transcript", "text": r.text, "confidence": r.confidence, "durationMs": r.duration_ms, "procMs": r.proc_ms})

    async def transcribe_clip(self, msg: dict) -> None:
        """Transcribe a whole clip (sample voice for auto tuning): base64 PCM16 mono 16 kHz."""
        import base64

        mid = msg.get("id")
        if self.stt is None:
            await self.send({"type": "error", "component": "clip", "id": mid, "message": "not_ready"})
            return
        loop = asyncio.get_running_loop()
        try:
            pcm = np.frombuffer(base64.b64decode(str(msg.get("pcm", ""))), dtype=np.int16).astype(np.float32) / 32768.0
            r = await loop.run_in_executor(self.stt_pool, lambda: self.stt.transcribe(pcm, ""))
            await self.send({"type": "clip_transcript", "id": mid, "text": r.text if r else ""})
        except Exception as e:  # noqa: BLE001
            await self.send({"type": "error", "component": "clip", "id": mid, "message": str(e)})

    # ------------------------------------------------------------ embeddings

    async def embed(self, msg: dict) -> None:
        try:
            await asyncio.wait_for(self.embed_ready.wait(), timeout=120)
        except asyncio.TimeoutError:
            await self.send({"type": "error", "component": "embed", "id": msg.get("id"), "message": "not_ready"})
            return
        loop = asyncio.get_running_loop()
        texts = [str(t) for t in msg.get("texts", [])]
        kind = msg.get("kind", "passage")
        try:
            vecs = await loop.run_in_executor(self.pool, lambda: self.embedder.embed(texts, kind))
            await self.send({"type": "embedding", "id": msg.get("id"), "vectors": [[round(float(x), 6) for x in v] for v in vecs]})
        except Exception as e:  # noqa: BLE001
            await self.send({"type": "error", "component": "embed", "id": msg.get("id"), "message": str(e)})

    # ------------------------------------------------------------ control

    async def on_json(self, msg: dict) -> None:
        t = msg.get("type")
        if t not in ("ping", "pong"):
            self.touch()
        if t == "listen_start":
            self.mode = msg.get("mode", "vad")
            if self.vad:
                self.vad.reset()
            self.listening = True
        elif t == "listen_stop":
            self.listening = False
            if self.vad and self.mode == "push":
                ev = self.vad.flush()
                if ev is not None:
                    await self.on_vad_event(ev)
                else:
                    await self.send({"type": "speech_end", "t": 0, "discarded": True})
            elif self.vad:
                self.vad.reset()
        elif t == "set_threshold":
            if self.vad:
                self.vad.set_boost(bool(msg.get("speakingBoost")))
        elif t == "set_vocab":
            self.vocab = [str(v) for v in msg.get("vocab", [])]
        elif t == "embed":
            asyncio.create_task(self.embed(msg))
        elif t == "transcribe_clip":
            asyncio.create_task(self.transcribe_clip(msg))
        elif t == "trim":
            await self.send({"type": "trimmed", "ok": trim_working_set()})
        elif t == "ping":
            await self.send({"type": "pong", "t": msg.get("t")})
        elif t == "pong":
            pass
        else:
            await self.send({"type": "error", "message": f"unknown type {t}"})

    async def handler(self, ws: ServerConnection) -> None:
        try:
            first = await asyncio.wait_for(ws.recv(), timeout=10)
            hello = json.loads(first)
            if hello.get("type") != "hello" or not hmac.compare_digest(str(hello.get("token", "")), self.token):
                await ws.close(4001, "unauthorized")
                return
        except Exception:  # noqa: BLE001
            await ws.close(4001, "unauthorized")
            return
        if self.ws is not None:
            await self.ws.close(4002, "replaced")
        self.ws = ws
        self.vocab = [str(v) for v in hello.get("vocab", [])]
        asyncio.create_task(self.load(hello))
        try:
            async for msg in ws:
                if isinstance(msg, (bytes, bytearray)):
                    await self.on_audio(bytes(msg))
                else:
                    try:
                        await self.on_json(json.loads(msg))
                    except Exception as e:  # noqa: BLE001
                        traceback.print_exc()
                        await self.send({"type": "error", "message": str(e)})
        finally:
            if self.ws is ws:
                self.ws = None
                self.listening = False


async def amain(port: int, token: str, models_dir: str | None) -> None:
    sc = Sidecar(token, models_dir)
    async with serve(sc.handler, "127.0.0.1", port, max_size=16 * 1024 * 1024, ping_interval=None) as server:
        actual = next(iter(server.sockets)).getsockname()[1]
        print(json.dumps({"port": actual}), flush=True)
        # exit when the parent closes our stdin (Electron died)
        loop = asyncio.get_running_loop()
        stop = loop.create_future()

        def watch_stdin() -> None:
            try:
                sys.stdin.read()
            finally:
                loop.call_soon_threadsafe(lambda: stop.done() or stop.set_result(None))

        loop.run_in_executor(None, watch_stdin)
        await stop


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--token", required=True)
    ap.add_argument("--models-dir", default=None)
    a = ap.parse_args()
    try:
        asyncio.run(amain(a.port, a.token, a.models_dir))
    except KeyboardInterrupt:
        pass
    os._exit(0)


if __name__ == "__main__":
    main()
