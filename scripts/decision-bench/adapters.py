"""Optional model adapters. Importing this module loads no model or ML library."""
from __future__ import annotations

import contextlib
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

LABELS = ("none", "warmth", "joy", "empathy", "curiosity", "surprise")
QUESTIONS = {"emotion": {"type": "choice", "instructions":
    "アシスタントが現在の返答を話す時の表情と声色を選ぶ。会話は参考情報。ユーザーの感情をまねない。",
    "criteria": dict(zip(LABELS, ("通常。落ち着いて説明する", "親しみ。温かく声をかける",
        "喜び。良い知らせを一緒に喜ぶ", "寄り添う。穏やかに安心させる",
        "興味。相手の話の続きを知りたい", "驚き。予想外のことに驚く")))}}
FORMAT_VERSION = "japanese-causal-state-v1"


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def digest(value):
    return hashlib.sha256(encoded(value)).hexdigest()


def wire_encoded(value):
    # Native decision heads can depend on option order; keep LABELS order in requests.
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()


def softmax(values, temperature=1.0):
    if not math.isfinite(temperature) or temperature <= 0:
        raise ValueError("invalid_temperature")
    values = [float(v) / temperature for v in values]
    if not values or not all(math.isfinite(v) for v in values):
        raise ValueError("invalid_logits")
    maximum = max(values)
    exps = [math.exp(v - maximum) for v in values]
    return dict(zip(LABELS, (v / sum(exps) for v in exps)))


def probabilities(values):
    if not isinstance(values, dict) or set(values) != set(LABELS):
        raise ValueError("invalid_probability_labels")
    if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v)
           or v < 0 or v > 1 for v in values.values()):
        raise ValueError("invalid_probabilities")
    total = sum(values.values())
    if abs(total - 1) > 0.001 or total <= 0:
        raise ValueError("invalid_probability_sum")
    return {k: values[k] / total for k in LABELS}, total


def model_fingerprint(directory):
    """Hash local model/config/tokenizer files; never load an arbitrary pickle."""
    root = Path(directory).resolve()
    files = sorted(p for p in root.rglob("*") if p.is_file() and
                   p.suffix in (".json", ".safetensors", ".onnx", ".onnx_data", ".data", ".model", ".txt", ".bin"))
    if not files:
        raise ValueError("empty_model_directory")
    h = hashlib.sha256()
    for path in files:
        h.update(str(path.relative_to(root)).encode())
        with path.open("rb") as stream:
            for part in iter(lambda: stream.read(1024 * 1024), b""):
                h.update(part)
    return h.hexdigest()


def serialize_state(state):
    titles = {"user": "ユーザーの発言", "previous_response": "直前の返答", "current_response": "現在の返答"}
    return "\n".join(f"[{titles[key]}]\n{state[key]}" for key in titles if key in state)


def input_format_hash():
    return digest({"version": FORMAT_VERSION, "example": serialize_state({
        "user": "USER", "previous_response": "PREVIOUS", "current_response": "CURRENT"})})


def file_hash(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for part in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(part)
    return h.hexdigest()


def resource_snapshot(pid):
    out = {"pid": pid, "rss_kib": None, "pss_kib": None, "peak_rss_kib": None,
           "swap_kib": None, "cpu_seconds": None, "threads": None}
    if pid is None:
        return out
    try:
        root = Path(f"/proc/{pid}")
        status = root.joinpath("status").read_text()
        fields = {line.split(":", 1)[0]: line.split(":", 1)[1].strip().split()[0]
                  for line in status.splitlines() if ":" in line and line.split(":", 1)[1].strip()}
        for key, source in (("rss_kib", "VmRSS"), ("peak_rss_kib", "VmHWM"),
                            ("swap_kib", "VmSwap"), ("threads", "Threads")):
            out[key] = int(fields[source]) if source in fields else None
        stat = root.joinpath("stat").read_text().rsplit(")", 1)[1].split()
        out["cpu_seconds"] = (int(stat[11]) + int(stat[12])) / os.sysconf("SC_CLK_TCK")
        try:
            for line in root.joinpath("smaps_rollup").read_text().splitlines():
                if line.startswith("Pss:"):
                    out["pss_kib"] = int(line.split()[1])
                if line.startswith("SwapPss:"):
                    out["swap_kib"] = int(line.split()[1])
        except (OSError, ValueError):
            pass
    except (OSError, ValueError, KeyError):
        if pid == os.getpid():
            try:
                import resource
                usage = resource.getrusage(resource.RUSAGE_SELF)
                out["peak_rss_kib"] = usage.ru_maxrss / (1024 if sys.platform == "darwin" else 1)
                out["cpu_seconds"] = usage.ru_utime + usage.ru_stime
            except ImportError:
                pass
    return out


class Fake:
    def __init__(self, config):
        self.metadata = {"model": "deterministic-fixture", "fingerprint": "fake-v1",
                         "transport": "local-worker", "device": "cpu", "threads": 1,
                         "quantization": "not_applicable", "fixture": True}

    def predict(self, state):
        index = int(digest(state)[:8], 16) % len(LABELS)
        return {"probabilities": {k: 0.75 if i == index else 0.05 for i, k in enumerate(LABELS)},
                "tokens": None, "truncated": False}


class LayaHTTP:
    def __init__(self, config):
        parsed = urllib.parse.urlsplit(config["endpoint"] or "")
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("invalid_endpoint")
        self.config = config
        self.metadata = {"model": config.get("model_id") or "laya-http-unverified",
            "revision": config.get("revision"), "fingerprint": None, "transport": "http",
            "device": "server-unverified", "threads": None, "quantization": "server-unverified",
            "fixture": False, "identity_verified": False}

    def predict(self, state):
        headers = {"Content-Type": "application/json"}
        token = os.environ.get("EUMENES_BENCH_TOKEN")
        if token:
            headers["Authorization"] = f"Bearer {token}"
        request = urllib.request.Request(self.config["endpoint"],
            wire_encoded({"state": state, "questions": QUESTIONS}), headers)
        with urllib.request.urlopen(request, timeout=self.config["timeout_ms"] / 1000) as response:
            body = response.read(1024 * 1024 + 1)
        if len(body) > 1024 * 1024:
            raise ValueError("response_too_large")
        return self.unpack(json.loads(body))

    def unpack(self, body):
        answer = body["answers"]["emotion"]
        if answer.get("type") != "choice" or answer.get("choice") not in LABELS:
            raise ValueError("invalid_choice")
        routing = body.get("routing", {})
        revision = routing.get("revision")
        model = body.get("model") or routing.get("model")
        for value in (model, revision):
            if value is not None and (not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9/_:.@+-]{1,200}", value)):
                raise ValueError("invalid_model_identity")
        if self.config.get("revision") and revision != self.config["revision"]:
            raise ValueError("revision_mismatch")
        reported = {"model": model, "revision": revision}
        fingerprint = digest(reported) if model and revision else None
        if self.metadata.get("fingerprint") and fingerprint != self.metadata["fingerprint"]:
            raise ValueError("model_changed_during_run")
        self.metadata.update({"model": model or self.metadata["model"], "revision": revision,
                              "fingerprint": fingerprint, "identity_verified": bool(fingerprint)})
        usage = body.get("usage", {})
        return {"probabilities": answer["probabilities"], "choice": answer["choice"],
                "tokens": usage.get("input_tokens"),
                "truncated": bool(usage.get("truncated") or usage.get("state_tokens_dropped", 0))}


class LayaLocal:
    def __init__(self, config):
        import torch
        import laya
        directory = Path(config["model_dir"] or "")
        if not directory.is_dir() or not (directory / "model.safetensors").is_file():
            raise ValueError("local_model_required")
        torch.set_num_threads(config["threads"])
        started = time.perf_counter()
        self.agent = laya.load(str(directory), device=config["device"])
        self.load_ms = (time.perf_counter() - started) * 1000
        if str(self.agent.device) != config["device"]:
            raise ValueError("device_fallback_rejected")
        self.config = config
        self.metadata = {"model": config.get("model_id") or directory.name,
            "revision": config.get("revision"), "fingerprint": model_fingerprint(directory),
            "transport": "local-worker", "device": str(self.agent.device),
            "threads": torch.get_num_threads(), "quantization": "unquantized",
            "dtype": str(self.agent.dtype), "amp": self.agent.amp_enabled,
            "laya_version": importlib.metadata.version("laya"), "torch_version": torch.__version__, "fixture": False}
        self.torch = torch

    def predict(self, state):
        synchronize(self.torch, self.config["device"])
        body = self.agent.predict(state, QUESTIONS, max_len=self.config["max_tokens"])
        synchronize(self.torch, self.config["device"])
        answer = body["answers"]["emotion"]
        usage = body.get("usage", {})
        return {"probabilities": answer["probabilities"], "choice": answer["choice"],
                "tokens": usage.get("input_tokens"),
                "truncated": bool(usage.get("truncated") or usage.get("state_tokens_dropped", 0))}


def synchronize(torch, device):
    if device.startswith("cuda"):
        torch.cuda.synchronize()
    elif device == "mps":
        torch.mps.synchronize()


class Encoder:
    def __init__(self, config):
        import numpy as np
        from transformers import AutoTokenizer
        directory = Path(config["model_dir"] or "")
        if not config["model_dir"] or not directory.is_dir():
            raise ValueError("local_model_required")
        self.config, self.np = config, np
        self.tokenizer = AutoTokenizer.from_pretrained(str(directory), local_files_only=True, trust_remote_code=False)
        started = time.perf_counter()
        if config["backend"] == "onnx":
            import onnxruntime as ort
            if config["device"] != "cpu" or not config.get("onnx"):
                raise ValueError("onnx_cpu_file_required")
            options = ort.SessionOptions()
            options.intra_op_num_threads = config["threads"]
            self.session = ort.InferenceSession(config["onnx"], options, providers=["CPUExecutionProvider"])
            self.model = None
            runtime = {"onnxruntime_version": ort.__version__}
        else:
            import torch
            from transformers import AutoModel
            self.torch = torch
            torch.set_num_threads(config["threads"])
            self.model = AutoModel.from_pretrained(str(directory), local_files_only=True,
                trust_remote_code=False, use_safetensors=True).to(config["device"]).eval()
            self.session = None
            runtime = {"torch_version": torch.__version__}
        self.load_ms = (time.perf_counter() - started) * 1000
        self.metadata = {"model": config.get("model_id") or directory.name,
            "revision": config.get("revision"), "fingerprint": model_fingerprint(directory),
            "transport": "local-worker", "device": config["device"], "backend": config["backend"],
            "threads": config["threads"], "quantization": config["quantization"], "fixture": False,
            "input_cache": False, "option_cache": config["adapter"] != "encoder-head", **runtime}
        self.metadata["serialization"] = self.prefix() + ":" + input_format_hash()
        self.metadata["transformers_version"] = importlib.metadata.version("transformers")
        if self.session is not None:
            self.metadata["onnx_sha256"] = file_hash(config["onnx"])
        else:
            self.metadata["dtype"] = str(next(self.model.parameters()).dtype)
        self.head = None
        if config["adapter"] == "encoder-head":
            self.head = json.loads(Path(config["head"] or "").read_text())
            if (self.head.get("trained") is not True or self.head.get("labels") != list(LABELS)
                or self.head.get("model_fingerprint") != self.metadata["fingerprint"]
                or self.head.get("input_format_sha256") != input_format_hash()
                or self.head.get("prefix") != self.prefix()
                or not isinstance(self.head.get("training_data_sha256"), str)
                or not re.fullmatch(r"[a-f0-9]{64}", self.head["training_data_sha256"])):
                raise ValueError("invalid_trained_head_metadata")
            self.weights, self.bias = np.asarray(self.head["weights"], dtype=np.float32), np.asarray(self.head["bias"], dtype=np.float32)
            if (self.weights.ndim != 2 or self.weights.shape[0] != 6 or self.bias.shape != (6,)
                or not np.isfinite(self.weights).all() or not np.isfinite(self.bias).all()):
                raise ValueError("invalid_trained_head_shape")
            self.metadata.update(head_sha256=digest(self.head), training_data_sha256=self.head["training_data_sha256"])
        else:
            options = [self.option_prefix() + QUESTIONS["emotion"]["instructions"] + "\n" + QUESTIONS["emotion"]["criteria"][k] for k in LABELS]
            self.options = np.stack([self.embed(text)[0] for text in options])

    def prefix(self):
        return "query: " if self.config["adapter"] == "verdict" else "トピック: "

    def option_prefix(self):
        return "passage: " if self.config["adapter"] == "verdict" else "トピック: "

    def embed(self, text):
        np = self.np
        inputs = self.tokenizer(text, return_tensors="np", truncation=False)
        tokens = int(inputs["input_ids"].shape[1])
        if tokens > self.config["max_tokens"]:
            raise ValueError("input_over_token_limit")
        if self.model is not None:
            torch = self.torch
            tensors = {k: torch.from_numpy(v).to(self.config["device"]) for k, v in inputs.items()}
            with torch.inference_mode():
                output = self.model(**tensors).last_hidden_state
                mask = tensors["attention_mask"].unsqueeze(-1)
                pooled = (output * mask).sum(1) / mask.sum(1).clamp(min=1)
                synchronize(torch, self.config["device"])
                vector = pooled.float().cpu().numpy()[0]
        else:
            names = {i.name for i in self.session.get_inputs()}
            feed = {k: v.astype(np.int64) for k, v in inputs.items() if k in names}
            if names - set(feed):
                raise ValueError("unsupported_onnx_inputs")
            output = self.session.run(None, feed)[0]
            if output.ndim != 3:
                raise ValueError("onnx_last_hidden_state_required")
            mask = inputs["attention_mask"][..., None]
            vector = ((output * mask).sum(1) / np.maximum(mask.sum(1), 1))[0]
        norm = float(np.linalg.norm(vector))
        if not math.isfinite(norm) or norm <= 0:
            raise ValueError("invalid_embedding")
        return vector / norm, tokens

    def predict(self, state):
        vector, tokens = self.embed(self.prefix() + serialize_state(state))
        if self.head is not None:
            if self.weights.shape[1] != vector.shape[0]:
                raise ValueError("head_embedding_dimension_mismatch")
            logits = self.weights @ vector + self.bias
        else:
            logits = (self.options @ vector) * 20
        return {"probabilities": softmax(logits.tolist()), "tokens": tokens, "truncated": False}


def error_code(exc):
    # Exception messages can contain input text, URLs, paths or credentials.
    if isinstance(exc, ModuleNotFoundError):
        return "missing_dependency:" + (exc.name or "unknown").split(".")[0]
    if isinstance(exc, (TimeoutError,)):
        return "timeout"
    if isinstance(exc, urllib.error.HTTPError):
        return "http_" + str(exc.code)
    if isinstance(exc, urllib.error.URLError):
        return "transport_error"
    known = {"invalid_endpoint", "response_too_large", "invalid_choice", "revision_mismatch",
        "model_changed_during_run", "local_model_required", "device_fallback_rejected",
        "onnx_cpu_file_required", "invalid_trained_head_metadata", "invalid_trained_head_shape",
        "input_over_token_limit", "unsupported_onnx_inputs", "onnx_last_hidden_state_required",
        "invalid_embedding", "head_embedding_dimension_mismatch", "invalid_probability_labels",
        "invalid_probabilities", "invalid_probability_sum", "empty_model_directory"}
    known.update(("invalid_token_count", "invalid_model_identity"))
    return str(exc) if isinstance(exc, ValueError) and str(exc) in known else type(exc).__name__


def worker():
    channel = sys.stdout
    def send(value):
        channel.write(encoded(value).decode() + "\n")
        channel.flush()
    with contextlib.redirect_stdout(sys.stderr):
        config = json.loads(sys.stdin.readline())
        try:
            adapter = {"fake": Fake, "laya-http": LayaHTTP, "laya-local": LayaLocal,
                "verdict": Encoder, "encoder-prototype": Encoder, "encoder-head": Encoder}[config["adapter"]](config)
            pid = config.get("pid") if config["adapter"] == "laya-http" else os.getpid()
            send({"ready": True, "metadata": adapter.metadata, "load_ms": getattr(adapter, "load_ms", None),
                  "resource": resource_snapshot(pid)})
        except Exception as exc:
            send({"ready": False, "error": error_code(exc)})
            return
        for line in sys.stdin:
            request = json.loads(line)
            if request.get("close"):
                break
            started = time.perf_counter()
            try:
                result = adapter.predict(request["state"])
                tokens = result.get("tokens")
                if tokens is not None and (type(tokens) is not int or tokens < 0):
                    raise ValueError("invalid_token_count")
                if tokens is not None and tokens > config.get("max_tokens", 512):
                    raise ValueError("input_over_token_limit")
                probs, total = probabilities(result["probabilities"])
                choice = max(LABELS, key=lambda k: probs[k])
                if result.get("choice") and abs(probs[result["choice"]] - probs[choice]) > 0.001:
                    raise ValueError("invalid_choice")
                result.update(probabilities=probs, probability_sum_original=total, choice=choice)
                send({"ok": True, **result, "prediction_ms": (time.perf_counter() - started) * 1000,
                      "resource": resource_snapshot(pid), "metadata": adapter.metadata})
            except Exception as exc:
                send({"ok": False, "error": error_code(exc), "prediction_ms": (time.perf_counter() - started) * 1000,
                      "resource": resource_snapshot(pid), "metadata": adapter.metadata})


if __name__ == "__main__":
    worker()
