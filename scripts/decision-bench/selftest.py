"""Deterministic acceptance checks; no real model, product DB, or external network."""
from __future__ import annotations

from contextlib import redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
from pathlib import Path
import tempfile
import threading
import sys
import unittest
from unittest.mock import patch

import bench
from adapters import LABELS, QUESTIONS, LayaHTTP, probabilities, digest, encoded


def case(group, index, label="none", split="test", transition=None):
    return {"id": f"{group}-{index}", "group": group, "index": index, "split": split,
            "user": "質問", "current": f"現在の返答{index}", "primary": label,
            "acceptable": [label], "transition": transition or ("start" if index == 0 else "hold")}


def prediction(group, index, label, values=None, gold=None, repeat=0, transition=None):
    row = case(group, index, gold or label, transition=transition)
    probs = dict(zip(LABELS, values)) if values else {k: .75 if k == label else .05 for k in LABELS}
    row.update(mode="C", repeat=repeat, source="synthetic", status="ok", prediction=label,
               probabilities=probs, roundtrip_ms=10, prediction_ms=8, preparation_ms=1,
               error=None, truncated=False)
    return row


class DatasetTests(unittest.TestCase):
    def test_shipped_dataset(self):
        rows = bench.validate_cases(bench.read_jsonl(bench.HERE / "cases.jsonl"))
        self.assertEqual(len(rows), 88)
        self.assertEqual({r["primary"] for r in rows if r["split"] == "calibration"}, set(LABELS))

    def test_rejects_duplicates_gaps_and_future_fields(self):
        for rows in ([case("a", 0), case("a", 0)], [case("a", 1)],
                     [{**case("a", 0), "future": "秘密の未来"}],
                     [case("a", 0), case("a", 1, split="calibration")],
                     [{**case("a", 0), "acceptable": ["joy"]}],
                     [{**case("a", 0), "index": True}]):
            with self.subTest(rows=rows), self.assertRaises(bench.BenchError):
                bench.validate_cases(rows)

    def test_template_and_user_are_not_mixed(self):
        with self.assertRaises(bench.BenchError):
            bench.validate_cases([{**case("a", 0), "template": "same"},
                {**case("b", 0, split="calibration"), "template": "same"}])
        with self.assertRaises(bench.BenchError):
            bench.validate_cases([case("a", 0), {**case("a", 1), "user": "次の質問"}])

    def test_context_is_causal_independent_of_input_order(self):
        cases = [case("a", 2), case("b", 0), case("a", 0), case("a", 1)]
        for mode in ("A", "B", "C"):
            states = bench.build_states(cases, mode)
            self.assertEqual(set(states["a-0"]), {"current_response"} if mode == "A" else {"current_response", "user"})
            self.assertNotIn("primary", str(states))
            self.assertNotIn("acceptable", str(states))
            if mode == "C":
                self.assertEqual(states["a-1"]["previous_response"], "現在の返答0")
                self.assertEqual(states["a-2"]["previous_response"], "現在の返答1")
                self.assertNotIn("previous_response", states["b-0"])


class ArithmeticTests(unittest.TestCase):
    def test_hand_computed_metrics_include_errors(self):
        rows = [case("a", 0, "none"), case("b", 0, "joy"), case("c", 0, "joy"), case("d", 0, "empathy")]
        metrics = bench.quality(rows, ["none", "joy", "none", None])
        self.assertEqual(metrics["accuracy"], .5)
        self.assertEqual(metrics["confusion"]["empathy"]["error"], 1)
        self.assertAlmostEqual(metrics["per_class"]["joy"]["f1"], 2 / 3)
        self.assertAlmostEqual(metrics["macro_f1"], 2 / 9)
        self.assertFalse(metrics["macro_f1_complete"])
        self.assertEqual(metrics["unacceptable_rate"], .5)

    def test_probability_rejection_and_rounding(self):
        p = {k: .1667 for k in LABELS}
        normalized, total = probabilities(p)
        self.assertAlmostEqual(total, 1.0002)
        self.assertAlmostEqual(sum(normalized.values()), 1)
        for bad in ({"none": 1}, {k: float("nan") for k in LABELS}, {k: .2 for k in LABELS},
                    {k: True for k in LABELS}):
            with self.assertRaises(ValueError):
                probabilities(bad)

    def test_reliability_matches_perfect_predictions(self):
        rows = [case("a", 0, "joy")]
        p = [{k: 1 if k == "joy" else 0 for k in LABELS}]
        self.assertEqual(bench.reliability(rows, p)["brier"], 0)
        self.assertEqual(bench.reliability(rows, p)["ece"], 0)
        self.assertEqual(bench.quantile([10, 20, 30], .95), 30)

    def test_hysteresis_is_reachable_and_strong_change_is_fast(self):
        rows = [prediction("a", 0, "joy"), prediction("a", 1, "curiosity", [.01, .01, .34, .01, .62, .01]),
                prediction("a", 2, "empathy", [.01, .01, .01, .95, .01, .01]), prediction("b", 0, "curiosity")]
        predicted = bench.apply_policy(rows, {"temperature": 1, "threshold": .6}, "hysteresis", None)[0]
        self.assertEqual(predicted, ["joy", "joy", "empathy", "curiosity"])

    def test_deadline_and_invalid_result_force_neutral(self):
        rows = [prediction("a", 0, "joy"), prediction("a", 1, "joy"), prediction("a", 2, "joy")]
        rows[0]["roundtrip_ms"] = 500  # Profiler/IPC overhead must not count as model time.
        rows[1]["prediction_ms"] = 200
        rows[2].update(status="error", error="invalid_probabilities", probabilities=None)
        predicted, reasons, _, _ = bench.apply_policy(rows, {"temperature": 1, "threshold": .6}, "vote3", 150)
        self.assertEqual(predicted, ["joy", "none", "none"])
        self.assertEqual(reasons[1:], ["deadline", "invalid_probabilities"])

    def test_majority_lag_is_visible_in_four_chunk_case(self):
        rows = [prediction("a", 0, "joy"), prediction("a", 1, "joy"),
                prediction("a", 2, "none", transition="change"), prediction("a", 3, "none")]
        predicted = bench.apply_policy(rows, {"temperature": 1, "threshold": .6}, "vote3", None)[0]
        self.assertEqual(predicted, ["joy", "joy", "joy", "none"])
        self.assertEqual(bench.transition_metrics(rows, predicted)["change_detection_rate"], 0)

    def test_boundary_annotations_drive_switch_metrics(self):
        rows = [prediction("a", 0, "joy"), prediction("a", 1, "joy"),
                prediction("a", 2, "none", transition="change"), prediction("a", 3, "none")]
        m = bench.transition_metrics(rows, ["joy", "curiosity", "curiosity", "none"])
        self.assertEqual(m["unnecessary_switch_rate"], 1)
        self.assertEqual(m["change_detection_rate"], 0)
        self.assertEqual(m["detected_change_delay_chunks"], 1)


class EndToEndTests(unittest.TestCase):
    def test_run_calibrate_score_are_offline_and_reproducible(self):
        with tempfile.TemporaryDirectory() as directory, redirect_stdout(io.StringIO()):
            root = Path(directory)
            run_dir, policy_file = root / "run", root / "policy.json"
            self.assertEqual(bench.main(["run", "--adapter", "fake", "--warmup", "0", "--repeats", "2", "--out", str(run_dir)]), 0)
            manifest, records = bench.load_run(run_dir)
            self.assertEqual(manifest["expected_records"], 528)
            self.assertNotIn("user", str(records))
            self.assertNotIn("current_response", str(records))
            self.assertTrue(manifest["metadata"]["fixture"])
            with patch.object(bench.Worker, "__init__", side_effect=AssertionError("offline must not call a model")):
                self.assertEqual(bench.main(["calibrate", "--input", str(run_dir), "--out", str(policy_file)]), 0)
                outputs = []
                for index in range(2):
                    out = root / f"score{index}"
                    self.assertEqual(bench.main(["score", "--input", str(run_dir), "--policy", str(policy_file), "--out", str(out)]), 0)
                    outputs.append(json.loads((out / "summary.json").read_text()))
                for output in outputs:
                    for summary in output["summaries"]:
                        summary.pop("policy_processing_total_ms")
                        self.assertEqual(summary["unique_cases"], 76)
                self.assertEqual(outputs[0], outputs[1])
                self.assertEqual(bench.main(["calibrate", "--input", str(run_dir), "--split", "test", "--out", str(root / "bad.json")]), 2)
            self.assertEqual(bench.main(["run", "--adapter", "fake", "--out", str(run_dir)]), 2)

    def test_policy_cannot_cross_model_or_calibration_groups(self):
        manifest = {"adapter": "fake", "metadata": {"model": "fake", "fingerprint": "one"},
                    "questions_sha256": digest(QUESTIONS), "input_format_sha256": "one", "modes": ["C"]}
        policy = {"binding": "wrong", "calibration_groups": [], "modes": {"C": {"temperature": 1, "threshold": .6}}}
        with self.assertRaises(bench.BenchError):
            bench.summarize_run(manifest, [prediction("a", 0, "joy")], "test", policy, ["none"], .6, None)
        policy["binding"] = bench.policy_binding(manifest)
        policy["calibration_groups"] = ["a"]
        with self.assertRaises(bench.BenchError):
            bench.summarize_run(manifest, [prediction("a", 0, "joy")], "test", policy, ["none"], .6, None)

    def test_http_worker_payload_and_server_identity(self):
        observed = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                observed.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
                body = encoded({"answers": {"emotion": {"type": "choice", "choice": "joy",
                    "probabilities": {k: .75 if k == "joy" else .05 for k in LABELS}}},
                    "model": "fixture-http", "routing": {"revision": "fixture-v1"},
                    "usage": {"input_tokens": 20, "truncated": False}})
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            config = {"adapter": "laya-http", "endpoint": f"http://127.0.0.1:{server.server_port}/v1/systemone",
                      "timeout_ms": 1000, "pid": None, "revision": "fixture-v1", "model_id": None}
            worker = bench.Worker(config, 2000)
            try:
                response = worker.predict({"current_response": "日本語の返答"}, 2000)
                self.assertTrue(response["ok"])
                self.assertEqual(response["choice"], "joy")
                self.assertTrue(response["metadata"]["identity_verified"])
                self.assertIsNone(response["resource"]["rss_kib"])
                self.assertEqual(set(observed[0]), {"state", "questions"})
                self.assertEqual(set(observed[0]["state"]), {"current_response"})
                self.assertEqual(list(observed[0]["questions"]["emotion"]["criteria"]), list(LABELS))
            finally:
                worker.close()
            adapter = LayaHTTP({**config, "revision": "wrong"})
            with self.assertRaises(ValueError):
                adapter.predict({"current_response": "返答"})
            with self.assertRaises(ValueError):
                LayaHTTP(config).unpack({"answers": {"emotion": {"type": "choice", "choice": "none"}},
                    "model": {"private": "provider text"}})
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_load_failure_has_manifest_and_safe_error(self):
        with tempfile.TemporaryDirectory() as directory, redirect_stdout(io.StringIO()):
            out = Path(directory) / "failed"
            self.assertEqual(bench.main(["run", "--adapter", "laya-http", "--endpoint",
                "http://user:secret@127.0.0.1:1", "--out", str(out)]), 3)
            manifest = json.loads((out / "manifest.json").read_text())
            self.assertEqual(manifest["status"], "incomplete")
            self.assertNotIn("secret", str(manifest))
            with self.assertRaises(bench.BenchError):
                bench.load_run(out)


def run_tests():
    suite = unittest.defaultTestLoader.loadTestsFromModule(sys.modules[__name__])
    return 0 if unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(run_tests())
