import { expect, test } from "bun:test";
import {
	readFileSync,
	writeFileSync,
	openSync,
	ftruncateSync,
	closeSync,
} from "node:fs";
import { join } from "node:path";
import { createRunner, publishSpec } from "../src/core";
import { runWorker } from "../src/worker";
import { atomicWrite, runPath, readPrivate } from "../src/storage";
import { spawn } from "node:child_process";
import { snapshot, git } from "../src/workspace";
import { publishGitSpec, executeGit } from "../src/git-operations";
import { fixture, until } from "./support";

async function completed(instruction = "normal") {
	const f = fixture();
	const runner = createRunner(f.configPath, true);
	const spec = f.spec(instruction);
	spec.operations.push("commit");
	publishSpec(f.config, "spec", spec);
	try {
		await runner.start("spec", spec.operationId, spec.executionId, false);
		const batch = await until(
			() => runner.inspect(spec.executionId, 0, 100, false),
			(b) => b.receipt.childrenStopped,
		);
		return {
			f,
			runner,
			spec,
			batch,
			path: runPath(f.config.spoolRoot, spec.executionId),
		};
	} catch (error) {
		f.close();
		throw error;
	}
}
for (const mode of ["failed", "nonzero"])
	test(`CLI ${mode} cannot supply complete evidence or authorize commit`, async () => {
		const { f, spec, batch } = await completed(mode);
		try {
			expect(batch.receipt.evidenceComplete).toBe(false);
			expect(batch.receipt.reason).toBe("runner_cli_failed");
			writeFileSync(join(f.workspace, "source.txt"), "changed\n");
			const commit = {
				version: "eumenes-coding/2" as const,
				kind: "commit" as const,
				operationId: crypto.randomUUID(),
				executionId: spec.executionId,
				generation: 1,
				snapshotDigest: snapshot(f.config, "fixture").digest,
				files: ["source.txt"],
				message: "change",
				authorName: "Fixture",
				authorEmail: "fixture@example.invalid",
			};
			publishGitSpec(f.config, "commit", commit);
			expect(() => executeGit(f.config, "commit", commit.operationId)).toThrow(
				"runner_git_authority_denied",
			);
			expect(git(f.workspace, ["rev-list", "--count", "HEAD"]).trim()).toBe(
				"1",
			);
		} finally {
			f.close();
		}
	});
test("cancel after pause irreversibly revokes the exact session and stop operation IDs cannot be rebound", async () => {
	const { f, runner, spec, batch } = await completed();
	try {
		runner.stop(spec.executionId, 1, "pause", "pause");
		runner.stop(spec.executionId, 1, "cancel", "cancel");
		runner.stop(spec.executionId, 1, "another-pause", "pause");
		expect(() => runner.stop(spec.executionId, 1, "cancel", "pause")).toThrow(
			"runner_operation_conflict",
		);
		const next = {
			...f.spec(),
			kind: "continue" as const,
			previousExecutionId: spec.executionId,
			deadlineAt: spec.deadlineAt,
			operations: spec.operations,
			sessionId: batch.receipt.sessionId,
		};
		publishSpec(f.config, "next", next);
		await expect(
			runner.start("next", next.operationId, next.executionId, true),
		).rejects.toThrow("runner_session_revoked");
	} finally {
		f.close();
	}
});
test("worker replay of a reserved receipt with CLI spawn intent stays unknown without launching again", async () => {
	const { f, spec, batch, path } = await completed();
	try {
		atomicWrite(join(path, "receipt.json"), {
			...batch.receipt,
			state: "reserved",
			seq: 0,
			sessionId: null,
			turnFinished: false,
			childrenStopped: false,
			exitCode: null,
		});
		await runWorker(join(path, "runner-config.json"), spec.executionId, true);
		const saved = JSON.parse(readFileSync(join(path, "receipt.json"), "utf8"));
		expect(saved.state).toBe("outcome_unknown");
		expect(saved.childrenStopped).toBe(false);
		expect(saved.reason).toBe("runner_spawn_outcome_unknown");
	} finally {
		f.close();
	}
});
test("concurrent start retries share one pinned configuration and one durable execution", async () => {
	const f = fixture();
	const runner = createRunner(f.configPath, true);
	const spec = f.spec();
	publishSpec(f.config, "spec", spec);
	try {
		atomicWrite(f.configPath, {
			...f.config,
			codexExecutable: "/unregistered/replacement",
		});
		const receipts = await Promise.all(
			Array.from({ length: 8 }, () =>
				runner.start("spec", spec.operationId, spec.executionId, false),
			),
		);
		expect(new Set(receipts.map((r) => r.executionId)).size).toBe(1);
		const b = await until(
			() => runner.inspect(spec.executionId, 0, 100, false),
			(b) => b.receipt.childrenStopped,
		);
		expect(b.receipt.turnFinished).toBe(true);
		expect(b.receipt.exitCode).toBe(0);
	} finally {
		f.close();
	}
});
test("evidence byte ranges preserve UTF-8 and reject changed payload bytes", async () => {
	const { f, runner, spec, batch, path } = await completed();
	try {
		const e = batch.events.find((e) => e.kind === "message")!;
		const all = runner.readEvidence(spec.executionId, e.payloadRef, 0, 65536);
		let offset = 0,
			text = "";
		while (offset < all.totalBytes) {
			const part = runner.readEvidence(
				spec.executionId,
				e.payloadRef,
				offset,
				4,
			);
			expect(part.nextOffset).toBeGreaterThan(offset);
			text += part.text;
			offset = part.nextOffset;
		}
		expect(text).toBe(all.text);
		expect(() =>
			runner.readEvidence(spec.executionId, e.payloadRef, 1, 4),
		).toThrow("runner_invalid_range");
		atomicWrite(join(path, "evidence", `${e.payloadRef}.txt`), "different");
		expect(() =>
			runner.readEvidence(spec.executionId, e.payloadRef, 0, 100),
		).toThrow("runner_evidence_digest_conflict");
	} finally {
		f.close();
	}
});
test("snapshot rejects an oversized sparse file before loading its contents", () => {
	const f = fixture();
	try {
		const fd = openSync(join(f.workspace, "large"), "w");
		try {
			ftruncateSync(fd, 65 * 1024 * 1024);
		} finally {
			closeSync(fd);
		}
		expect(() => snapshot(f.config, "fixture")).toThrow(
			"runner_snapshot_limit",
		);
	} finally {
		f.close();
	}
});

test("evidence preserves a leading Unicode BOM as part of its authenticated payload", async () => {
	const { f, runner, spec, batch } = await completed("bom");
	try {
		const e = batch.events.find((e) => e.kind === "message")!;
		const read = runner.readEvidence(spec.executionId, e.payloadRef, 0, 65536);
		expect(read.text).toBe("\uFEFF日本語");
		expect(read.digest).toBe(e.payloadDigest);
	} finally {
		f.close();
	}
});

test("terminal receipt waits for the durable process-exited event even when finalization is delayed", async () => {
	const f = fixture();
	f.config.fixtureLimits!.finalEventDelayMs = 400;
	atomicWrite(f.configPath, f.config);
	const runner = createRunner(f.configPath, true);
	const spec = f.spec();
	publishSpec(f.config, "spec", spec);
	try {
		await runner.start("spec", spec.operationId, spec.executionId, false);
		const partial = await until(
			() => runner.inspect(spec.executionId, 0, 100, false),
			(b) => b.events.some((e) => e.kind === "file_changed"),
		);
		expect(partial.receipt.childrenStopped).toBe(false);
		expect(partial.receipt.state).toBe("running");
		const terminal = await until(
			() => runner.inspect(spec.executionId, 0, 100, false),
			(b) => b.receipt.childrenStopped,
		);
		expect(terminal.events.at(-1)?.kind).toBe("process_exited");
		expect(terminal.receipt.seq).toBe(terminal.events.at(-1)!.seq);
	} finally {
		f.close();
	}
});

test("concurrent atomic receipt replacements remain readable from the already opened private inode", async () => {
	const f = fixture();
	const path = join(f.root, "receipt.json");
	const value = "x".repeat(128 * 1024);
	atomicWrite(path, value);
	const source = `import { atomicWrite } from ${JSON.stringify(join(import.meta.dir, "../src/storage.ts"))}; process.stdout.write("ready\\n"); for(let i=0;i<200;i++) atomicWrite(${JSON.stringify(path)}, "x".repeat(128*1024));`;
	const child = spawn(process.execPath, ["-e", source], {
		stdio: ["ignore", "pipe", "ignore"],
		env: { PATH: "/usr/bin:/bin" },
	});
	const closed = new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	});
	try {
		await new Promise<void>((resolve, reject) => {
			child.stdout!.once("data", () => resolve());
			child.once("error", reject);
			child.once("close", () => reject(new Error("fixture_writer_closed")));
		});
		for (let i = 0; i < 1000; i++) expect(readPrivate(path)).toBe(value);
		expect(await closed).toBe(0);
	} finally {
		child.kill();
		await closed.catch(() => {});
		f.close();
	}
});
