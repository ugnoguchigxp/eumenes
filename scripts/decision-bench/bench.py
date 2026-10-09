#!/usr/bin/env python3
"""Standalone causal decision benchmark. No product imports, DB, or model downloads."""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import csv
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import random
import re
import select
import subprocess
import sys
import time
import uuid

sys.dont_write_bytecode = True
from adapters import LABELS, QUESTIONS, FORMAT_VERSION, digest, encoded, input_format_hash, softmax, wire_encoded

HERE = Path(__file__).resolve().parent
SCHEMA_VERSION = 1
TRANSITIONS = ("none", "hysteresis", "vote3", "ema", "min-chunks")


class BenchError(Exception):
    pass


def require(condition, code):
    if not condition:
        raise BenchError(code)


def write_json(path, value):
    Path(path).write_bytes(encoded(value) + b"\n")


def read_jsonl(path):
    rows = []
    with Path(path).open(encoding="utf-8") as stream:
        for number, line in enumerate(stream, 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except (ValueError, UnicodeError):
                raise BenchError(f"invalid_json_line:{number}") from None
            require(isinstance(row, dict), f"invalid_object_line:{number}")
            rows.append(row)
    return rows


def validate_cases(rows):
    require(bool(rows), "empty_dataset")
    ids, groups, templates = set(), defaultdict(list), defaultdict(set)
    fields = {"id", "group", "index", "split", "user", "current", "primary", "acceptable",
              "transition", "tags", "source", "template"}
    opaque = re.compile(r"[A-Za-z0-9_.:-]{1,100}\Z")
    for row in rows:
        require(not set(row) - fields, "unknown_dataset_fields")
        for key in ("id", "group"):
            require(isinstance(row.get(key), str) and opaque.fullmatch(row[key]), "invalid_case_identifier")
        require(row["id"] not in ids, "duplicate_case_id")
        ids.add(row["id"])
        require(type(row.get("index")) is int and row["index"] >= 0, "invalid_index")
        require(row.get("split") in ("train", "calibration", "test"), "invalid_split")
        for key in ("user", "current"):
            require(isinstance(row.get(key), str) and row[key].strip() and len(row[key]) <= 65536, "invalid_case_text")
        require(row.get("primary") in LABELS, "invalid_primary")
        allowed = row.get("acceptable")
        require(isinstance(allowed, list) and allowed and all(k in LABELS for k in allowed)
                and len(set(allowed)) == len(allowed) and row["primary"] in allowed, "invalid_acceptable")
        require(row.get("transition") in ("start", "hold", "change", "any"), "invalid_transition")
        require(row.get("source", "synthetic") in ("synthetic", "real"), "invalid_source")
        require(isinstance(row.get("tags", []), list) and all(isinstance(t, str) and opaque.fullmatch(t)
                for t in row.get("tags", [])), "invalid_tags")
        if "template" in row:
            require(isinstance(row["template"], str) and opaque.fullmatch(row["template"]), "invalid_template")
            templates[row["template"]].add(row["split"])
        groups[row["group"]].append(row)
    for sequence in groups.values():
        sequence.sort(key=lambda r: r["index"])
        require([r["index"] for r in sequence] == list(range(len(sequence))), "group_index_gap_or_duplicate")
        require(len({r["split"] for r in sequence}) == 1, "group_crosses_splits")
        require(len({r["user"] for r in sequence}) == 1, "group_user_changed")
        require(len({r.get("source", "synthetic") for r in sequence}) == 1, "group_source_changed")
        require(sequence[0]["transition"] == "start" and all(r["transition"] != "start" for r in sequence[1:]), "invalid_transition_start")
    require(all(len(splits) == 1 for splits in templates.values()), "template_crosses_splits")
    return sorted(rows, key=lambda r: (r["group"], r["index"]))


def build_states(cases, mode):
    previous, result = {}, {}
    for case in sorted(cases, key=lambda r: (r["group"], r["index"])):
        state = {}
        if mode != "A":
            state["user"] = case["user"]
        if mode == "C" and case["group"] in previous:
            state["previous_response"] = previous[case["group"]]
        state["current_response"] = case["current"]
        previous[case["group"]] = case["current"]
        result[case["id"]] = state
    return result


class Worker:
    def __init__(self, config, load_timeout_ms):
        # No shell or token arguments. Each benchmark owns only this child process.
        started = time.perf_counter()
        self.child = subprocess.Popen([sys.executable, "-B", str(HERE / "adapters.py")],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0)
        self.buffer = b""
        try:
            self.send(config)
            self.ready = self.receive(load_timeout_ms)
            require(self.ready.get("ready"), "adapter_load_failed:" + str(self.ready.get("error", "unknown")))
        except BaseException:
            self.close()
            raise
        self.startup_ms = (time.perf_counter() - started) * 1000

    def send(self, message):
        self.child.stdin.write(wire_encoded(message) + b"\n")
        self.child.stdin.flush()

    def receive(self, timeout_ms):
        deadline = time.perf_counter() + timeout_ms / 1000
        while b"\n" not in self.buffer:
            remaining = deadline - time.perf_counter()
            if remaining <= 0 or not select.select([self.child.stdout], [], [], remaining)[0]:
                raise BenchError("worker_timeout")
            part = os.read(self.child.stdout.fileno(), 65536)
            require(bool(part), "worker_exited")
            self.buffer += part
            require(len(self.buffer) <= 2 * 1024 * 1024, "worker_response_too_large")
        line, self.buffer = self.buffer.split(b"\n", 1)
        try:
            value = json.loads(line)
        except ValueError:
            raise BenchError("invalid_worker_response") from None
        require(isinstance(value, dict), "invalid_worker_response")
        return value

    def predict(self, state, timeout_ms):
        started = time.perf_counter()
        self.send({"state": state})
        result = self.receive(timeout_ms)
        result["roundtrip_ms"] = (time.perf_counter() - started) * 1000
        return result

    def close(self):
        if self.child.poll() is None:
            try:
                self.send({"close": True})
                self.child.wait(timeout=1)
            except (OSError, subprocess.TimeoutExpired):
                self.child.terminate()
                try:
                    self.child.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    self.child.kill()
                    self.child.wait()
        for stream in (self.child.stdin, self.child.stdout):
            if stream:
                stream.close()


def policy_binding(manifest):
    meta = manifest["metadata"]
    return digest({"adapter": manifest["adapter"], "metadata": {k: meta.get(k) for k in
        ("model", "revision", "fingerprint", "transport", "device", "quantization", "backend", "dtype", "amp", "head_sha256", "onnx_sha256", "serialization")},
        "questions_sha256": manifest["questions_sha256"], "input_format_sha256": manifest["input_format_sha256"]})


def run(args):
    cases = validate_cases(read_jsonl(args.data))
    out = Path(args.out) if args.out else Path.cwd() / "verification-reports/decision-bench" / (
        datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ-") + uuid.uuid4().hex[:8])
    out.mkdir(parents=True, exist_ok=False, mode=0o700)
    config = {k: getattr(args, k) for k in ("adapter", "endpoint", "pid", "model_dir", "model_id", "revision",
              "device", "threads", "backend", "onnx", "head", "quantization", "max_tokens", "timeout_ms")}
    manifest = {"schema_version": SCHEMA_VERSION, "status": "running", "run_id": out.name,
        "created_at": datetime.now(timezone.utc).isoformat(), "adapter": args.adapter,
        "dataset_sha256": digest(cases), "questions_sha256": digest(QUESTIONS),
        "input_format_sha256": input_format_hash(), "format_version": FORMAT_VERSION,
        "code_sha256": hashlib.sha256((HERE / "bench.py").read_bytes() + (HERE / "adapters.py").read_bytes()).hexdigest(),
        "labels": list(LABELS), "modes": args.modes, "repeats": args.repeats,
        "warmup": args.warmup, "seed": args.seed, "expected_records": len(cases) * len(args.modes) * args.repeats,
        "actual_records": 0, "failures": 0, "metadata": {},
        "host": {"system": platform.system(), "machine": platform.machine(), "cpu": platform.processor(),
                 "logical_cpus": os.cpu_count(), "python": platform.python_version()},
        "timeout_ms": args.timeout_ms, "requested_threads": args.threads,
        "max_tokens": args.max_tokens, "filesystem_cache": "not_cleared",
        "prediction_timing": "adapter_predict_including_tokenization_or_http; excludes_resource_sample",
        "tts_measured": False, "load_ms": None, "startup_ms": None}
    write_json(out / "manifest.json", manifest)
    worker = None
    records = []
    try:
        worker = Worker(config, args.load_timeout_ms)
        manifest.update(metadata=worker.ready["metadata"], load_ms=worker.ready["load_ms"], startup_ms=worker.startup_ms)
        with (out / "resources.jsonl").open("wb") as resources, (out / "predictions.jsonl").open("wb") as predictions:
            resources.write(encoded({"stage": "ready", **worker.ready["resource"]}) + b"\n")
            # Same benign first input across runs; it is not part of accuracy or warm latency.
            first = worker.predict({"current_response": "おはようございます。"}, args.timeout_ms + 250)
            require(first.get("ok"), "first_prediction_failed:" + str(first.get("error", "unknown")))
            manifest["first_prediction_ms"] = first["prediction_ms"]
            for _ in range(args.warmup):
                warm = worker.predict({"current_response": "おはようございます。"}, args.timeout_ms + 250)
                require(warm.get("ok"), "warmup_failed:" + str(warm.get("error", "unknown")))
            states = {mode: build_states(cases, mode) for mode in args.modes}
            jobs = [(case, mode, repeat) for repeat in range(args.repeats) for case in cases for mode in args.modes]
            random.Random(args.seed).shuffle(jobs)
            warm_started = time.perf_counter()
            before = warm.get("resource") if args.warmup else first.get("resource")
            for case, mode, repeat in jobs:
                preparation = time.perf_counter()
                state = states[mode][case["id"]]
                input_hash = digest(state)
                preparation_ms = (time.perf_counter() - preparation) * 1000
                row = {k: case[k] for k in ("id", "group", "index", "split", "primary", "acceptable", "transition")}
                row.update(mode=mode, repeat=repeat, source=case.get("source", "synthetic"),
                           tags=case.get("tags", []), template=case.get("template", case["group"]),
                           input_sha256=input_hash, preparation_ms=preparation_ms)
                try:
                    result = worker.predict(state, args.timeout_ms + 250)
                    manifest["metadata"] = result["metadata"]
                    row.update(status="ok" if result["ok"] else "error", error=result.get("error"),
                        prediction=result.get("choice"), probabilities=result.get("probabilities"),
                        probability_sum_original=result.get("probability_sum_original"),
                        tokens=result.get("tokens"), truncated=result.get("truncated", False),
                        prediction_ms=result["prediction_ms"], roundtrip_ms=result["roundtrip_ms"])
                    if row["truncated"]:
                        row.update(status="error", error="truncated_input", prediction=None)
                    if not result["ok"] or row["truncated"]:
                        manifest["failures"] += 1
                    resources.write(encoded({"stage": "prediction", "id": case["id"], "mode": mode,
                        "repeat": repeat, **result["resource"]}) + b"\n")
                except BenchError as exc:
                    row.update(status="error", error=str(exc), prediction=None, probabilities=None,
                               truncated=False, prediction_ms=None, roundtrip_ms=None)
                    manifest["failures"] += 1
                    records.append(row)
                    predictions.write(encoded(row) + b"\n")
                    predictions.flush()
                    raise
                records.append(row)
                predictions.write(encoded(row) + b"\n")
                predictions.flush()
                resources.flush()
                if row.get("error") in ("timeout", "transport_error"):
                    raise BenchError("transport_failure_stopped_run")
            after = result["resource"]
            wall = time.perf_counter() - warm_started
            cpu = (after["cpu_seconds"] - before["cpu_seconds"]) if before and before["cpu_seconds"] is not None and after["cpu_seconds"] is not None else None
            manifest["warm_resources"] = {"wall_seconds": wall, "cpu_seconds": cpu,
                "average_busy_logical_cores": cpu / wall if cpu is not None else None}
            manifest["last_resources"] = after
            manifest["status"] = "completed_with_errors" if manifest["failures"] else "completed"
    except KeyboardInterrupt:
        manifest.update(status="interrupted", failure="interrupted")
    except Exception as exc:
        manifest.update(status="incomplete", failure=str(exc) if isinstance(exc, BenchError) else type(exc).__name__)
    finally:
        if worker:
            worker.close()
        manifest["actual_records"] = len(records)
        manifest["policy_binding"] = policy_binding(manifest)
        raw_path = out / "predictions.jsonl"
        manifest["predictions_sha256"] = hashlib.sha256(raw_path.read_bytes()).hexdigest() if raw_path.exists() else None
        write_json(out / "manifest.json", manifest)
    if records:
        resource_rows = read_jsonl(out / "resources.jsonl")
        manifest["resource_peaks"] = {k: max((r[k] for r in resource_rows if r.get(k) is not None), default=None)
            for k in ("rss_kib", "pss_kib", "swap_kib", "peak_rss_kib")}
        write_json(out / "manifest.json", manifest)
        summaries = summarize_run(manifest, records, "test", None, ["none"], 0.6, None)
        save_report(out, summaries, [manifest])
    print(encoded({"out": str(out), "status": manifest["status"], "records": len(records), "failures": manifest["failures"]}).decode())
    return 0 if manifest["status"] == "completed" else 3


def quantile(values, q):
    values = sorted(v for v in values if v is not None)
    return values[min(len(values) - 1, math.ceil(len(values) * q) - 1)] if values else None


def quality(rows, predictions):
    confusion = {k: {p: 0 for p in (*LABELS, "error")} for k in LABELS}
    for row, predicted in zip(rows, predictions):
        confusion[row["primary"]][predicted if predicted in LABELS else "error"] += 1
    per_class = {}
    for k in LABELS:
        tp = confusion[k][k]
        support = sum(confusion[k].values())
        fp = sum(confusion[other][k] for other in LABELS if other != k)
        fn = support - tp
        per_class[k] = {"support": support, "precision": tp / (tp + fp) if tp + fp else 0,
                        "recall": tp / support if support else None,
                        "f1": 2 * tp / (2 * tp + fp + fn) if support else None}
    n = len(rows)
    f1 = [per_class[k]["f1"] or 0 for k in LABELS]
    expressive = [i for i, r in enumerate(rows) if r["primary"] != "none"]
    neutral = [i for i, r in enumerate(rows) if r["primary"] == "none"]
    return {"unique_cases": n, "accuracy": sum(r["primary"] == p for r, p in zip(rows, predictions)) / n if n else None,
        "macro_f1": sum(f1) / 6 if n else None, "macro_f1_complete": all(per_class[k]["support"] for k in LABELS),
        "missing_classes": [k for k in LABELS if not per_class[k]["support"]],
        "unacceptable_rate": sum(p not in r["acceptable"] for r, p in zip(rows, predictions)) / n if n else None,
        "expression_recall": sum(predictions[i] == rows[i]["primary"] for i in expressive) / len(expressive) if expressive else None,
        "neutral_false_rate": sum(predictions[i] not in ("none", None) for i in neutral) / len(neutral) if neutral else None,
        "per_class": per_class, "confusion": confusion}


def reliability(rows, probs):
    bins = [{"n": 0, "confidence_sum": 0.0, "correct": 0} for _ in range(10)]
    brier = []
    for row, p in zip(rows, probs):
        if p is None:
            continue
        predicted = max(LABELS, key=lambda k: p[k])
        confidence = p[predicted]
        slot = bins[min(9, int(confidence * 10))]
        slot["n"] += 1
        slot["confidence_sum"] += confidence
        slot["correct"] += predicted == row["primary"]
        brier.append(sum((p[k] - (k == row["primary"])) ** 2 for k in LABELS))
    n = len(brier)
    return {"ece": sum(abs(b["confidence_sum"] - b["correct"]) for b in bins) / n if n else None,
            "brier": sum(brier) / n if n else None, "reliability_cases": n, "bins": bins}


def rescale(p, temperature):
    return softmax([math.log(max(p[k], 1e-12)) for k in LABELS], temperature)


def apply_policy(rows, settings, transition, deadline_ms):
    output, reasons, transformed = [], [], []
    states = {}
    started = time.perf_counter()
    for row in rows:
        key = (row["group"], row["repeat"])
        state = states.setdefault(key, {"previous": "none", "age": 0, "history": [], "smooth": None})
        previous = state["previous"]
        p = rescale(row["probabilities"], settings["temperature"]) if row["status"] == "ok" else None
        reason = None
        if p is None:
            predicted, reason = "none", row.get("error") or "error"
        elif deadline_ms is not None and row["prediction_ms"] + row["preparation_ms"] > deadline_ms:
            predicted, reason = "none", "deadline"
        else:
            predicted = max(LABELS, key=lambda k: p[k])
            if p[predicted] < settings["threshold"]:
                predicted, reason = "none", "low_confidence"
        state["history"].append(predicted)
        if reason is None and p is not None:
            if transition == "hysteresis" and predicted not in ("none", previous) and previous != "none" and p[predicted] < 0.8 and p[previous] >= 0.25 and p[predicted] - p[previous] <= 0.30:
                predicted = previous
            elif transition == "vote3":
                recent = state["history"][-3:]
                counts = Counter(recent)
                predicted = next(k for k in reversed(recent) if counts[k] == max(counts.values()))
            elif transition == "min-chunks" and predicted not in ("none", previous) and previous != "none" and state["age"] < 2 and p[predicted] < 0.85:
                predicted = previous
            elif transition == "ema":
                smooth = p if state["smooth"] is None else {k: 0.65 * p[k] + 0.35 * state["smooth"][k] for k in LABELS}
                state["smooth"] = smooth
                if max(p.values()) < 0.85:
                    predicted = max(LABELS, key=lambda k: smooth[k])
                    if smooth[predicted] < settings["threshold"]:
                        predicted, reason = "none", "low_confidence"
        else:
            state["smooth"] = None
        state["age"] = state["age"] + 1 if predicted == previous else 1
        state["previous"] = predicted
        output.append(predicted)
        reasons.append(reason)
        transformed.append(p)
    return output, reasons, transformed, (time.perf_counter() - started) * 1000


def transition_metrics(rows, predictions):
    sequences = defaultdict(list)
    for row, p in zip(rows, predictions):
        sequences[(row["group"], row["repeat"])].append((row, p))
    hold = hold_switch = change = change_hit = 0
    delays = []
    for seq in sequences.values():
        seq.sort(key=lambda item: item[0]["index"])
        for i, (row, p) in enumerate(seq[1:], 1):
            previous = seq[i - 1][1]
            if row["transition"] == "hold":
                hold += 1
                hold_switch += p != previous
            elif row["transition"] == "change":
                change += 1
                change_hit += p is not None and p != previous and p in row["acceptable"]
                for delay, (later, lp) in enumerate(seq[i:]):
                    if delay and later["transition"] == "change":
                        break
                    if lp is not None and lp != previous and lp in row["acceptable"]:
                        delays.append(delay)
                        break
    return {"hold_boundaries": hold, "unnecessary_switch_rate": hold_switch / hold if hold else None,
            "change_boundaries": change, "change_detection_rate": change_hit / change if change else None,
            "detected_change_delay_chunks": sum(delays) / len(delays) if delays else None}


def summarize_run(manifest, records, split, policy, transitions, threshold, deadline_ms, decision_sink=None):
    selected = [r for r in records if r["split"] == split]
    summaries = []
    if policy:
        require(policy["binding"] == policy_binding(manifest), "policy_model_or_format_mismatch")
        require(not set(policy["calibration_groups"]) & {r["group"] for r in selected}, "policy_calibration_group_leak")
        require(not set(policy.get("calibration_templates", [])) & {r.get("template", r["group"]) for r in selected}, "policy_calibration_template_leak")
    for mode in manifest["modes"]:
        all_rows = sorted([r for r in selected if r["mode"] == mode], key=lambda r: (r["repeat"], r["group"], r["index"]))
        if not all_rows:
            continue
        first_rows = [r for r in all_rows if r["repeat"] == 0]
        require(first_rows, "missing_primary_repeat")
        settings = policy["modes"][mode] if policy else {"temperature": 1, "threshold": threshold}
        for method in ("raw", *transitions):
            if method == "raw":
                preds = [r["prediction"] if r["status"] == "ok" else None for r in all_rows]
                reasons = [r.get("error") if r["status"] != "ok" else None for r in all_rows]
                probs = [r["probabilities"] if r["status"] == "ok" else None for r in all_rows]
                processing_ms = 0
            else:
                preds, reasons, probs, processing_ms = apply_policy(all_rows, settings, method, deadline_ms)
            indices = [i for i, r in enumerate(all_rows) if r["repeat"] == 0]
            primary_predictions = [preds[i] for i in indices]
            primary_probs = [probs[i] for i in indices]
            group_key = digest({"dataset": manifest["dataset_sha256"], "format": manifest["input_format_sha256"],
                "questions": manifest["questions_sha256"], "transport": manifest["metadata"].get("transport"),
                "device": manifest["metadata"].get("device"), "threads": manifest["metadata"].get("threads"),
                "training": "head" if manifest["metadata"].get("head_sha256") else "zero-shot",
                "fixture": manifest["metadata"].get("fixture"), "code": manifest["code_sha256"],
                "max_tokens": manifest["max_tokens"],
                "repeats": manifest["repeats"], "seed": manifest["seed"]})[:16]
            if decision_sink is not None:
                for row, predicted, reason in zip(all_rows, preds, reasons):
                    decision_sink.append({"run_id": manifest["run_id"], "id": row["id"], "mode": mode,
                        "repeat": row["repeat"], "transition": method, "prediction": predicted,
                        "primary": row["primary"], "reason": reason})
            summaries.append({"run_id": manifest["run_id"], "comparison_group": group_key,
                "model": manifest["metadata"].get("model"), "revision": manifest["metadata"].get("revision"),
                "adapter": manifest["adapter"], "mode": mode, "transition": method, "split": split,
                "policy_sha256": digest(policy) if policy else None,
                "policy_settings": None if method == "raw" else settings, "deadline_ms": None if method == "raw" else deadline_ms,
                **quality(first_rows, primary_predictions), **reliability(first_rows, primary_probs),
                **transition_metrics(first_rows, primary_predictions),
                "source_scores": {source: quality([r for r in first_rows if r["source"] == source],
                    [p for r, p in zip(first_rows, primary_predictions) if r["source"] == source])
                    for source in sorted({r["source"] for r in first_rows})},
                "failure_examples": [r["id"] for r, p in zip(first_rows, primary_predictions) if p != r["primary"]],
                "failures": sum(r["status"] != "ok" for r in first_rows),
                "fallback_reasons": dict(Counter(reasons[i] for i in indices if reasons[i])),
                "request_count": len(all_rows), "latency_p50_ms": quantile([r["prediction_ms"] for r in all_rows], .5),
                "latency_p95_ms": quantile([r["prediction_ms"] for r in all_rows], .95),
                "roundtrip_p95_ms": quantile([r["roundtrip_ms"] for r in all_rows], .95),
                "policy_processing_total_ms": processing_ms if method != "raw" else None,
                "reliability_scope": "model_probabilities_before_transition",
                "load_ms": manifest["load_ms"], "startup_ms": manifest["startup_ms"],
                "first_prediction_ms": manifest.get("first_prediction_ms"),
                "rss_kib": manifest.get("last_resources", {}).get("rss_kib"),
                "pss_kib": manifest.get("last_resources", {}).get("pss_kib"),
                "swap_kib": manifest.get("last_resources", {}).get("swap_kib"),
                "resource_peaks": manifest.get("resource_peaks"),
                "average_busy_logical_cores": manifest.get("warm_resources", {}).get("average_busy_logical_cores"),
                "accuracy_by_repeat": {str(repeat): quality([r for r in all_rows if r["repeat"] == repeat],
                    [p for r, p in zip(all_rows, preds) if r["repeat"] == repeat])["accuracy"]
                    for repeat in sorted({r["repeat"] for r in all_rows})}})
    return summaries


def save_report(out, summaries, manifests):
    out = Path(out)
    analysis_hash = hashlib.sha256((HERE / "bench.py").read_bytes() + (HERE / "adapters.py").read_bytes()).hexdigest()
    write_json(out / "summary.json", {"schema_version": SCHEMA_VERSION, "analysis_code_sha256": analysis_hash,
                                     "summaries": summaries, "runs": manifests})
    columns = ["run_id", "comparison_group", "model", "adapter", "mode", "transition", "unique_cases",
               "accuracy", "macro_f1", "unacceptable_rate", "expression_recall", "neutral_false_rate",
               "latency_p50_ms", "latency_p95_ms", "roundtrip_p95_ms", "failures",
               "load_ms", "startup_ms", "rss_kib", "pss_kib", "swap_kib", "average_busy_logical_cores"]
    with (out / "comparison.csv").open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        safe = lambda v: "'" + v if isinstance(v, str) and v.startswith(("=", "+", "-", "@")) else v
        writer.writerows({k: safe(v) for k, v in row.items()} for row in summaries)
    lines = ["# 判断モデルのベンチマーク結果", "", "品質はrepeat 0の固有例、速度は全反復。異なるcomparison groupは直接順位付けしない。",
        "実際のTTS開始・再生同期・声色は未測定。Dは保存した確率の再集計。", ""]
    for group in sorted({s["comparison_group"] for s in summaries}):
        lines += [f"## 比較条件 {group}", "", "| Run | 入力 | 制御 | 固有例 | 一致率 | Macro F1 | 許容外率 | P50/P95 ms |",
                  "| --- | --- | --- | ---: | ---: | ---: | ---: | --- |"]
        def fmt(v):
            return f"{v:.3f}" if isinstance(v, (float, int)) else "未測定"
        for s in summaries:
            if s["comparison_group"] == group:
                latency = "C等のraw測定を参照" if s["transition"] != "raw" else f"{fmt(s['latency_p50_ms'])}/{fmt(s['latency_p95_ms'])}"
                lines.append(f"| {s['run_id']} | {s['mode']} | {s['transition']} | {s['unique_cases']} | {fmt(s['accuracy'])} | {fmt(s['macro_f1'])} | {fmt(s['unacceptable_rate'])} | {latency} |")
        lines.append("")
    for s in summaries:
        lines += [f"## {s['run_id']} {s['mode']} {s['transition']}", "", "### 混同行列", "",
                  "| 正解 / 予測 | " + " | ".join((*LABELS, "error")) + " |", "| --- | " + " | ".join(["---:"] * 7) + " |"]
        for k in LABELS:
            lines.append("| " + k + " | " + " | ".join(str(s["confusion"][k][p]) for p in (*LABELS, "error")) + " |")
        lines += ["", "主ラベル不一致の例ID: " + (", ".join(s["failure_examples"]) or "なし"),
                  "評価例のないクラス: " + (", ".join(s["missing_classes"]) or "なし"), ""]
    (out / "report.md").write_text("\n".join(lines), encoding="utf-8")


def load_run(directory, allow_incomplete=False):
    directory = Path(directory)
    manifest = json.loads((directory / "manifest.json").read_text())
    require(manifest.get("schema_version") == SCHEMA_VERSION, "unsupported_schema")
    require(allow_incomplete or manifest["status"] in ("completed", "completed_with_errors"), "incomplete_run")
    records = read_jsonl(directory / "predictions.jsonl")
    require(hashlib.sha256((directory / "predictions.jsonl").read_bytes()).hexdigest() == manifest.get("predictions_sha256"), "predictions_hash_mismatch")
    require(len(records) == manifest["actual_records"], "record_count_mismatch")
    require(allow_incomplete or len(records) == manifest["expected_records"], "missing_records")
    require(len({(r["id"], r["mode"], r["repeat"]) for r in records}) == len(records), "duplicate_prediction")
    return manifest, records


def calibrate(args):
    require(args.split == "calibration", "calibration_split_required")
    manifest, records = load_run(args.input)
    require(manifest["metadata"].get("fingerprint"), "unverified_model_identity")
    selected = [r for r in records if r["split"] == "calibration" and r["repeat"] == 0]
    require(selected, "missing_calibration_examples")
    require(all(r["status"] == "ok" and r.get("probabilities") for r in selected), "failed_calibration_examples")
    policy = {"schema_version": 1, "binding": policy_binding(manifest), "dataset_sha256": manifest["dataset_sha256"],
        "calibration_groups": sorted({r["group"] for r in selected}), "split": "calibration",
        "calibration_templates": sorted({r.get("template", r["group"]) for r in selected}),
        "objective": "temperature:NLL; threshold:macro_f1; exploratory_small_dataset", "modes": {}}
    for mode in manifest["modes"]:
        rows = [r for r in selected if r["mode"] == mode]
        require(rows, "missing_calibration_mode")
        require(set(r["primary"] for r in rows) == set(LABELS), "calibration_missing_classes")
        temperatures = (.25, .35, .5, .7, 1, 1.4, 2, 3, 4, 6, 8)
        def nll(t):
            return -sum(math.log(max(rescale(r["probabilities"], t)[r["primary"]], 1e-12)) for r in rows) / len(rows)
        temperature = min(temperatures, key=nll)
        thresholds = (0, .35, .45, .55, .6, .65, .7, .75, .8, .85, .9, .95)
        def objective(threshold):
            predicted = apply_policy(rows, {"temperature": temperature, "threshold": threshold}, "none", None)[0]
            return quality(rows, predicted)["macro_f1"], threshold
        threshold = max(thresholds, key=objective)
        policy["modes"][mode] = {"temperature": temperature, "threshold": threshold,
            "calibration_cases": len(rows), "nll": nll(temperature)}
    path = Path(args.out)
    require(not path.exists(), "output_exists")
    path.parent.mkdir(parents=True, exist_ok=True)
    write_json(path, policy)
    print(encoded({"out": str(path), "modes": policy["modes"]}).decode())
    return 0


def score(args):
    require(args.split != "train", "train_split_not_evaluation")
    policy = json.loads(Path(args.policy).read_text()) if args.policy else None
    if policy:
        require(policy.get("schema_version") == 1 and policy.get("split") == "calibration", "invalid_policy")
        for settings in policy["modes"].values():
            require(isinstance(settings["temperature"], (int, float)) and math.isfinite(settings["temperature"])
                    and settings["temperature"] > 0 and 0 <= settings["threshold"] <= 1, "invalid_policy_settings")
    manifests, summaries, decisions = [], [], []
    for path in args.input:
        manifest, records = load_run(path, args.allow_incomplete)
        require(not policy or args.split == "test", "calibrated_policy_test_only")
        manifests.append(manifest)
        require(any(r["split"] == args.split for r in records), "missing_score_split")
        summaries += summarize_run(manifest, records, args.split, policy, args.transitions, args.threshold, args.deadline_ms, decisions)
    out = Path(args.out) if args.out else Path.cwd() / "verification-reports/decision-bench" / ("score-" + uuid.uuid4().hex[:8])
    out.mkdir(parents=True, exist_ok=False, mode=0o700)
    save_report(out, summaries, manifests)
    with (out / "decisions.jsonl").open("wb") as stream:
        for row in decisions:
            stream.write(encoded(row) + b"\n")
    print(encoded({"out": str(out), "summaries": len(summaries), "model_calls": 0}).decode())
    return 0


def positive_int(value):
    n = int(value)
    if n <= 0:
        raise argparse.ArgumentTypeError("must_be_positive")
    return n


def bounded_float(value):
    n = float(value)
    if not math.isfinite(n) or not 0 <= n <= 1:
        raise argparse.ArgumentTypeError("must_be_between_zero_and_one")
    return n


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="command", required=True)
    validate = sub.add_parser("validate", help="Check a Japanese labeled JSONL dataset")
    validate.add_argument("--data", default=str(HERE / "cases.jsonl"))
    r = sub.add_parser("run", help="Explicit model measurement; writes a new result directory")
    r.add_argument("--data", default=str(HERE / "cases.jsonl"))
    r.add_argument("--adapter", choices=("fake", "laya-http", "laya-local", "verdict", "encoder-prototype", "encoder-head"), required=True)
    r.add_argument("--endpoint")
    r.add_argument("--pid", type=positive_int, help="HTTP inference server PID on this host")
    r.add_argument("--model-dir")
    r.add_argument("--model-id")
    r.add_argument("--revision")
    r.add_argument("--device", choices=("cpu", "cuda", "mps"), default="cpu")
    r.add_argument("--threads", type=positive_int, default=4)
    r.add_argument("--backend", choices=("torch", "onnx"), default="torch")
    r.add_argument("--onnx")
    r.add_argument("--head")
    r.add_argument("--quantization", choices=("unquantized", "int8"), default="unquantized")
    r.add_argument("--max-tokens", type=positive_int, default=512)
    r.add_argument("--modes", nargs="+", choices=("A", "B", "C"), default=["A", "B", "C"])
    r.add_argument("--repeats", type=positive_int, default=3)
    r.add_argument("--warmup", type=int, default=10)
    r.add_argument("--seed", type=int, default=20261009)
    r.add_argument("--timeout-ms", type=positive_int, default=2000)
    r.add_argument("--load-timeout-ms", type=positive_int, default=120000)
    r.add_argument("--out")
    c = sub.add_parser("calibrate", help="Fit temperature and threshold using calibration only; no model calls")
    c.add_argument("--input", required=True)
    c.add_argument("--split", choices=("calibration", "test", "train"), default="calibration")
    c.add_argument("--out", required=True)
    s = sub.add_parser("score", help="Offline quality and transition comparisons; no model calls")
    s.add_argument("--input", nargs="+", required=True)
    s.add_argument("--split", choices=("test", "calibration", "train"), default="test")
    s.add_argument("--policy")
    s.add_argument("--threshold", type=bounded_float, default=.6)
    s.add_argument("--deadline-ms", type=positive_int)
    s.add_argument("--transitions", nargs="+", choices=TRANSITIONS, default=list(TRANSITIONS))
    s.add_argument("--allow-incomplete", action="store_true")
    s.add_argument("--out")
    sub.add_parser("self-test", help="Offline contract, arithmetic and HTTP/worker tests")
    return p


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv[:1] == ["--"]:
        argv = argv[1:]
    args = parser().parse_args(argv)
    try:
        if args.command == "validate":
            rows = validate_cases(read_jsonl(args.data))
            print(encoded({"cases": len(rows), "groups": len({r['group'] for r in rows}),
                "splits": dict(Counter(r["split"] for r in rows)), "classes": dict(Counter(r["primary"] for r in rows)),
                "dataset_sha256": digest(rows)}).decode())
            return 0
        if args.command == "run":
            require(args.warmup >= 0 and args.repeats <= 100, "invalid_repeat_or_warmup")
            require(len(set(args.modes)) == len(args.modes), "duplicate_mode")
            require(args.adapter in ("verdict", "encoder-prototype", "encoder-head") or args.backend == "torch", "unsupported_adapter_backend")
            require(not (args.backend == "torch" and args.quantization != "unquantized"), "torch_quantization_not_supported")
            return run(args)
        if args.command == "calibrate":
            return calibrate(args)
        if args.command == "score":
            require(len(set(args.transitions)) == len(args.transitions), "duplicate_transition")
            return score(args)
        from selftest import run_tests
        return run_tests()
    except (BenchError, OSError, ValueError, KeyError, TypeError) as exc:
        # Never echo dataset content, authentication values, or provider responses.
        code = str(exc) if isinstance(exc, BenchError) else type(exc).__name__
        print(encoded({"error": code}).decode(), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
