import json
import os
import subprocess
import sys

import numpy as np
import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from stt import is_hallucination  # noqa: E402
from vad import CHUNK, Segmenter, VadConfig, SileroStream, StreamingVad  # noqa: E402


def chunk(v=0.0):
    return np.full(CHUNK, v, dtype=np.float32)


def test_segmenter_start_end_and_preroll():
    seg = Segmenter(VadConfig())
    events = []
    for _ in range(20):  # silence: fills preroll
        events += seg.feed(chunk(0.01), 0.05)
    assert events == []
    for _ in range(40):  # ~1.3 s speech
        events += seg.feed(chunk(0.5), 0.9)
    assert [e.kind for e in events] == ["start"]
    for _ in range(25):  # 0.8 s silence
        events += seg.feed(chunk(0.0), 0.1)
    assert [e.kind for e in events] == ["start", "end"]
    audio = events[-1].audio
    assert audio is not None
    # preroll (~0.3 s) + speech + trailing silence
    assert len(audio) / 16000 > 1.3 + 0.25


def test_segmenter_discards_short_blips():
    seg = Segmenter(VadConfig())
    ev = []
    for _ in range(4):
        ev += seg.feed(chunk(0.5), 0.9)  # ~130 ms
    for _ in range(25):
        ev += seg.feed(chunk(0.0), 0.0)
    assert [e.kind for e in ev] == ["start", "end"]
    assert ev[-1].audio is None


def test_boost_requires_higher_probability():
    seg = Segmenter(VadConfig(), boosted=True)
    ev = []
    for _ in range(10):
        ev += seg.feed(chunk(0.5), 0.6)
    assert ev == []


def test_flush_for_push_to_talk():
    seg = Segmenter(VadConfig())
    for _ in range(30):
        seg.feed(chunk(0.5), 0.9)
    ev = seg.flush()
    assert ev is not None and ev.audio is not None


def test_hallucination_filter():
    assert is_hallucination("ご視聴ありがとうございました")
    assert is_hallucination("ああああああああ")
    assert is_hallucination("はい。はい。はい。はい。はい。はい。")
    assert not is_hallucination("明日の天気を教えて")
    assert is_hallucination("")


def test_silero_runs_on_silence_and_noise():
    m = SileroStream()
    p0 = m.prob(np.zeros(CHUNK, dtype=np.float32))
    assert 0.0 <= p0 < 0.3
    v = StreamingVad(m)
    pcm = (np.zeros(16000) * 32767).astype("<i2").tobytes()
    assert v.push_pcm16(pcm) == []


def test_server_requires_token_and_answers_ping():
    import asyncio
    from websockets.asyncio.client import connect

    proc = subprocess.Popen(
        [sys.executable, "-I", os.path.join(os.path.dirname(HERE), "main.py"), "--port", "0", "--token", "secret"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
    )
    try:
        port = json.loads(proc.stdout.readline())["port"]

        async def run():
            async with connect(f"ws://127.0.0.1:{port}") as ws:
                await ws.send(json.dumps({"type": "hello", "token": "wrong"}))
                with pytest.raises(Exception):
                    await ws.recv()
            async with connect(f"ws://127.0.0.1:{port}") as ws:
                await ws.send(json.dumps({"type": "hello", "token": "secret", "stt": False}))
                await ws.send(json.dumps({"type": "ping", "t": 1}))
                seen = []
                for _ in range(5):
                    msg = json.loads(await asyncio.wait_for(ws.recv(), 30))
                    seen.append(msg["type"])
                    if msg["type"] == "pong":
                        break
                assert "pong" in seen

        asyncio.run(run())
    finally:
        proc.stdin.close()
        proc.wait(timeout=10)
