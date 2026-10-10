"""multilingual-e5-small sentence embeddings via ONNX Runtime (no torch). 384-dim, L2-normalized."""
from __future__ import annotations

import os

import numpy as np

REPO = "Xenova/multilingual-e5-small"
MODEL_FILE = "onnx/model_quantized.onnx"


class E5Embedder:
    dim = 384

    def __init__(self, cache_dir: str | None = None):
        import onnxruntime as ort
        from huggingface_hub import hf_hub_download
        from tokenizers import Tokenizer

        kw = {"cache_dir": cache_dir} if cache_dir else {}
        model_path = hf_hub_download(REPO, MODEL_FILE, **kw)
        tok_path = hf_hub_download(REPO, "tokenizer.json", **kw)
        self.tokenizer = Tokenizer.from_file(tok_path)
        self.tokenizer.enable_truncation(max_length=256)
        self.tokenizer.enable_padding(pad_id=self.tokenizer.token_to_id("<pad>") or 1, pad_token="<pad>")
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = max(1, (os.cpu_count() or 4) // 4)
        opts.log_severity_level = 3
        self.session = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"], sess_options=opts)
        self.input_names = {i.name for i in self.session.get_inputs()}

    def embed(self, texts: list[str], kind: str = "passage") -> np.ndarray:
        if not texts:
            return np.zeros((0, self.dim), dtype=np.float32)
        prefix = "query: " if kind == "query" else "passage: "
        enc = self.tokenizer.encode_batch([prefix + t for t in texts])
        ids = np.array([e.ids for e in enc], dtype=np.int64)
        mask = np.array([e.attention_mask for e in enc], dtype=np.int64)
        feeds = {"input_ids": ids, "attention_mask": mask}
        if "token_type_ids" in self.input_names:
            feeds["token_type_ids"] = np.zeros_like(ids)
        hidden = self.session.run(None, feeds)[0]  # (batch, seq, 384)
        m = mask[..., None].astype(np.float32)
        pooled = (hidden * m).sum(axis=1) / np.clip(m.sum(axis=1), 1e-9, None)
        norm = np.linalg.norm(pooled, axis=1, keepdims=True)
        return (pooled / np.clip(norm, 1e-12, None)).astype(np.float32)
