import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRunner, publishSpec } from "../src/core";
import { connectRunner } from "../src/client";
import { JsonLineDecoder } from "../src/decoder";
import { atomicWrite, runPath } from "../src/storage";
import { fixture, until } from "./support";

describe("coding runner", () => {
	test("review evidence is invalidated if the workspace changes during its turn", async () => {
		const f = fixture();
		const runner = createRunner(f.configPath, true);
		const spec = { ...f.spec("edit"), kind: "review" as const };
		publishSpec(f.config, "spec", spec);
		try {
			await runner.start("spec", spec.operationId, spec.executionId, false);
			const r = await until(
				() => runner.inspect(spec.executionId, 0, 100, false),
				(r) => r.receipt.childrenStopped,
			);
			expect(r.receipt.evidenceComplete).toBe(false);
			expect(r.receipt.reason).toBe("review_snapshot_changed");
		} finally {
			f.close();
		}
	});
	test("a spec that requests the registered network is refused before the CLI starts", async () => {
		const f = fixture();
		const runner = createRunner(f.configPath, true);
		const spec = { ...f.spec(), network: "registered" as const };
		publishSpec(f.config, "spec", spec);
		try {
			await runner.start("spec", spec.operationId, spec.executionId, false);
			const r = await until(
				() => runner.inspect(spec.executionId, 0, 100, false),
				(r) => r.receipt.childrenStopped,
			);
			expect(r.receipt.reason).toBe("runner_network_policy_unsupported");
			expect(r.receipt.evidenceComplete).toBe(false);
			expect(
				readdirSync(runPath(f.config.spoolRoot, spec.executionId)),
			).not.toContain("cli-spawn-intent.json");
		} finally {
			f.close();
		}
	});
	test("backend credentials and SSH agent are absent from the CLI environment", async () => {
		const f = fixture();
		const runner = createRunner(f.configPath, true);
		const spec = f.spec("env");
		publishSpec(f.config, "spec", spec);
		const original = process.env.EUMENES_TEST_TOKEN;
		process.env.EUMENES_TEST_TOKEN = "fixture-sentinel";
		try {
			await runner.start("spec", spec.operationId, spec.executionId, false);
			const r = await until(
				() => runner.inspect(spec.executionId, 0, 100, false),
				(r) => r.receipt.childrenStopped,
			);
			const e = r.events.find((e) => e.kind === "message")!;
			expect(
				runner.readEvidence(spec.executionId, e.payloadRef, 0, 100).text,
			).toBe("");
		} finally {
			if (original === undefined) delete process.env.EUMENES_TEST_TOKEN;
			else process.env.EUMENES_TEST_TOKEN = original;
			f.close();
		}
	});
	test("UTF-8 fragments, incomplete and oversized lines are bounded", () => {
		const lines: string[] = [];
		const faults: string[] = [];
		const decoder = new JsonLineDecoder(
			(s) => lines.push(s),
			(s) => faults.push(s),
			128,
		);
		const bytes = Buffer.from('{"text":"日本語"}\n');
		for (const b of bytes) decoder.feed(Uint8Array.of(b));
		expect(lines).toEqual(['{"text":"日本語"}']);
		decoder.feed(Buffer.from("x".repeat(129)));
		decoder.feed(Buffer.from("\n{}\n{"));
		decoder.finish();
		expect(lines).toEqual(['{"text":"日本語"}', "{}"]);
		expect(faults).toEqual(["runner_line_limit", "runner_partial_line"]);
	});
	test("production refuses fixture configuration", () => {
		const f = fixture();
		try {
			expect(() => createRunner(f.configPath)).toThrow(
				"runner_fixture_forbidden",
			);
		} finally {
			f.close();
		}
	});
	test("stdio MCP start, durable duplicate receipt, inspect and private normalized evidence", async () => {
		const f = fixture();
		const spec = f.spec();
		const ref = crypto.randomUUID();
		publishSpec(f.config, ref, spec);
		const client = await connectRunner({
			executable: process.execPath,
			serverPath: join(import.meta.dir, "fixture-server.ts"),
			configPath: f.configPath,
		});
		try {
			expect((await client.probe("fixture")).available).toBe(true);
			const first = await client.start(ref, spec);
			expect(first.executionId).toBe(spec.executionId);
			const duplicate = await client.start(ref, spec);
			expect(duplicate.executionId).toBe(first.executionId);
			const observed = await until(
				() => client.inspect(spec.executionId, 0, 100),
				(r) => r.receipt.childrenStopped,
			);
			expect(observed.receipt.state).toBe("exited");
			expect(observed.receipt.turnFinished).toBe(true);
			expect(observed.receipt.evidenceComplete).toBe(true);
			expect(observed.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
			expect(observed.events.map((e) => e.kind)).toEqual([
				"session",
				"message",
				"turn_finished",
				"file_changed",
				"process_exited",
			]);
			const e = observed.events[1]!;
			const material = await client.readEvidence(
				spec.executionId,
				e.payloadRef,
				0,
				65536,
			);
			expect(material.text).toContain("実装しました");
			expect(material.text).not.toContain("sk-testsecret");
			expect(material.digest).toBe(e.payloadDigest);
			expect(
				lstatSync(runPath(f.config.spoolRoot, spec.executionId)).mode & 0o077,
			).toBe(0);
			await expect(
				client.readEvidence(spec.executionId, "unregistered", 0, 50),
			).rejects.toThrow("runner_evidence_not_registered");
			expect(readdirSync(join(f.config.spoolRoot, "runs"))).toHaveLength(1);
		} finally {
			await client.close();
			f.close();
		}
	}, 15000);
	test("stop is an intent; owning worker confirms process group termination", async () => {
		const f = fixture();
		const runner = createRunner(f.configPath, true);
		const spec = f.spec("long");
		publishSpec(f.config, "spec", spec);
		try {
			await runner.start("spec", spec.operationId, spec.executionId, false);
			await until(
				() => runner.inspect(spec.executionId, 0, 100, false),
				(r) => r.receipt.state === "running",
			);
			const requested = runner.stop(spec.executionId, 1, "stop-one", "cancel");
			expect(requested.state).toBe("stopping");
			expect(requested.childrenStopped).toBe(false);
			const ended = await until(
				() => runner.inspect(spec.executionId, 0, 100, false),
				(r) => r.receipt.childrenStopped,
			);
			expect(ended.receipt.state).toBe("stopped");
			expect(ended.receipt.reason).toBe("cancel");
		} finally {
			f.close();
		}
	});
	test("MCP disconnect does not stop the worker; host lease eventually does", async () => {
		const f = fixture();
		f.config.fixtureLimits!.leaseMs = 200;
		atomicWrite(f.configPath, f.config);
		const spec = f.spec("long");
		publishSpec(f.config, "spec", spec);
		const runner = createRunner(f.configPath, true);
		const client = await connectRunner({
			executable: process.execPath,
			serverPath: join(import.meta.dir, "fixture-server.ts"),
			configPath: f.configPath,
		});
		try {
			await client.start("spec", spec);
			await client.close();
			const ended = await until(
				() => runner.inspect(spec.executionId, 0, 100, false),
				(r) => r.receipt.childrenStopped,
			);
			expect(["host_lease_expired", "stopped_before_spawn"]).toContain(
				ended.receipt.reason!,
			);
		} finally {
			await client.close();
			f.close();
		}
	});
	test("background children are stopped before completion", async () => {
		const f = fixture();
		const runner = createRunner(f.configPath, true);
		const spec = f.spec("background");
		publishSpec(f.config, "spec", spec);
		try {
			await runner.start("spec", spec.operationId, spec.executionId, false);
			const ended = await until(
				() => runner.inspect(spec.executionId, 0, 100, false),
				(r) => r.receipt.childrenStopped,
			);
			expect(ended.receipt.turnFinished).toBe(true);
		} finally {
			f.close();
		}
	});
	test("oversized output drains and stops with incomplete evidence", async () => {
		const f = fixture();
		const runner = createRunner(f.configPath, true);
		const spec = f.spec("flood");
		publishSpec(f.config, "spec", spec);
		try {
			await runner.start("spec", spec.operationId, spec.executionId, false);
			const ended = await until(
				() => runner.inspect(spec.executionId, 0, 100, false),
				(r) => r.receipt.childrenStopped,
			);
			expect(ended.receipt.evidenceComplete).toBe(false);
			expect(ended.receipt.reason).toBe("runner_line_limit");
		} finally {
			f.close();
		}
	});
	test("saved spawn intent is never replayed, unknown PID is never signalled", async () => {
		const f = fixture();
		const runner = createRunner(f.configPath, true);
		const spec = f.spec();
		publishSpec(f.config, "spec", spec);
		try {
			await runner.start("spec", spec.operationId, spec.executionId, false);
			await until(
				() => runner.inspect(spec.executionId, 0, 100, false),
				(r) => r.receipt.childrenStopped,
			);
			const path = join(
				runPath(f.config.spoolRoot, spec.executionId),
				"receipt.json",
			);
			const receipt = JSON.parse(readFileSync(path, "utf8"));
			receipt.state = "running";
			receipt.childrenStopped = false;
			receipt.updatedAt = Date.now() - 200000;
			atomicWrite(path, receipt);
			atomicWrite(
				join(runPath(f.config.spoolRoot, spec.executionId), "process.json"),
				{ pid: process.pid, nonce: "untrusted" },
			);
			expect(
				(await runner.start("spec", spec.operationId, spec.executionId, false))
					.state,
			).toBe("outcome_unknown");
			expect(runner.stop(spec.executionId, 1, "stop", "cancel").state).toBe(
				"outcome_unknown",
			);
			expect(readdirSync(join(f.config.spoolRoot, "runs"))).toHaveLength(1);
		} finally {
			f.close();
		}
	});
	test("workspace and executable replacement are rejected", async () => {
		const f = fixture();
		const runner = createRunner(f.configPath, true);
		try {
			writeFileSync(f.config.codexExecutable, "#!/bin/sh\nexit 0\n");
			await expect(runner.probe("fixture")).rejects.toThrow(
				"runner_executable_changed",
			);
		} finally {
			f.close();
		}
	});
});
