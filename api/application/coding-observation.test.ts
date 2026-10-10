import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { openStore, type SqliteStore } from "../infrastructure/sqlite";
import { createCoding, migration as codingMigration } from "../domains/coding";
import { semanticObservationDigest } from "../domains/coding-supervision";
import { connectRunner } from "../../packages/coding-runner/src/client";
import { publishSpec } from "../../packages/coding-runner/src/core";
import { atomicWrite } from "../../packages/coding-runner/src/storage";
import { fixture, until } from "../../packages/coding-runner/test/support";
import {
	codingObservationReader,
	observationFailure,
} from "./coding-observation";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
async function run(mode: string, wide = false) {
	const f = fixture();
	cleanup.push(f.close);
	if (wide)
		atomicWrite(f.configPath, {
			...f.config,
			fixtureLimits: {
				...f.config.fixtureLimits,
				maxLineBytes: 1048576,
				maxRunBytes: 1048576,
			},
		});
	const store: SqliteStore = openStore(join(f.root, "test.sqlite"), [
		codingMigration,
	]);
	cleanup.push(() => store.close());
	const runner = await connectRunner({
		executable: process.execPath,
		serverPath: join(
			import.meta.dir,
			"../../packages/coding-runner/test/fixture-server.ts",
		),
		configPath: f.configPath,
	});
	cleanup.push(() => runner.close());
	const coding = createCoding({
		store,
		runner,
		publishSpec: (ref, spec) => publishSpec(f.config, ref, spec),
	});
	await store.write((db) =>
		coding.registerWorkspaceInTransaction(db, {
			id: "fixture",
			branch: "codex/fixture",
			available: true,
			reason: null,
		}),
	);
	const authority = {
		taskId: "task",
		generation: 1,
		authorityEpoch: 1,
		workspaceId: "fixture",
		branch: "codex/fixture",
		operations: ["read", "edit"] as ["read", "edit"],
		network: "none" as const,
		deadlineAt: Date.now() + 30000,
	};
	const p = await store.write((db) =>
		coding.prepareInTransaction(db, authority, {
			operationId: crypto.randomUUID(),
			instruction: mode,
			kind: "implement",
		}),
	);
	await coding.dispatch(p);
	const batch = await until(
		() => coding.inspect(p.spec.executionId, 0, 100, false),
		(r) => r.receipt.childrenStopped && r.receipt.state !== "stopping",
	);
	await store.write((db) => coding.adoptInTransaction(db, authority, batch));
	return {
		store,
		coding,
		batch,
		p,
		reader: codingObservationReader(store, coding),
	};
}
const signal = () => new AbortController().signal;

test("a normal run exposes unknown-kind speech, a stopped terminal and no identifiable final", async () => {
	const { reader } = await run("normal");
	const o = await reader.inspect("task", signal());
	const d = o.details!;
	expect(d.run).toMatchObject({
		turnOutcome: "completed",
		captureState: "complete",
		processStarted: true,
	});
	expect(d.messages.map((m) => m.metadata.messageKind)).toEqual(["unknown"]);
	expect(d.finalReport).toBe("unidentifiable");
	expect(d.publicReport).toBe("nonempty_observed");
	expect(d.limitations).toContain("classification_unknown");
	expect(d.limitations).not.toContain("not_fully_observed");
	expect(o.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
	expect(o.turnFinished && o.childrenStopped && o.evidenceComplete).toBe(true);
	expect(o.excerpt).toContain("実装しました");
	expect(o.excerpt).not.toContain("sk-testsecret");
	expect(o.facts[0]).toBe("turn終端: completed");
});
test("a long message keeps sourceTruncated, is read only within this observation's bound, and is not full coverage", async () => {
	const { reader } = await run("longmsg", true);
	const d = (await reader.inspect("task", signal())).details!;
	expect(d.messages[0]!.metadata.sourceTruncated).toBe(true);
	expect(d.limitations).toEqual(
		expect.arrayContaining(["source_truncated", "not_fully_observed"]),
	);
	const c = d.coverage.find((v) => v.ref === d.messages[0]!.ref)!;
	expect(c.ranges[0]![0]).toBe(0);
	expect(c.ranges[0]![1]).toBeLessThan(c.totalBytes);
	expect(d.run.captureState).toBe("complete");
});
test("an empty-only report is reported as empty, not as failure", async () => {
	const { reader } = await run("emptymsg");
	const d = (await reader.inspect("task", signal())).details!;
	expect(d.publicReport).toBe("empty_only");
	expect(d.run.turnOutcome).toBe("completed");
});
test("a failed turn is reported as failed with a complete capture", async () => {
	const { reader } = await run("failed");
	const o = await reader.inspect("task", signal());
	expect(o.details!.run).toMatchObject({
		turnOutcome: "failed",
		captureState: "complete",
	});
	expect(o.turnFinished).toBe(false);
});
test("changed evidence digest or a state change while reading is rejected, not adopted", async () => {
	const { store, coding } = await run("normal");
	const corrupt = codingObservationReader(store, {
		...coding,
		readEvidence: async (...a: Parameters<typeof coding.readEvidence>) => ({
			...(await coding.readEvidence(...a)),
			digest: "0".repeat(64),
		}),
	} as typeof coding);
	await expect(corrupt.inspect("task", signal())).rejects.toThrow(
		"runner_evidence_digest_conflict",
	);
	const moving = codingObservationReader(store, {
		...coding,
		readEvidence: async (...a: Parameters<typeof coding.readEvidence>) => {
			await store.write((db) =>
				db.query("UPDATE coding_executions SET state='stopping'").run(),
			);
			return coding.readEvidence(...a);
		},
	} as typeof coding);
	await expect(moving.inspect("task", signal())).rejects.toThrow(
		"coding_observation_stale",
	);
});
test("a failed observation is named by a fixed code and the last adopted cursor", async () => {
	const { store, coding, batch } = await run("normal");
	const f = observationFailure(
		store,
		coding,
		"task",
		new Error("coding_event_gap"),
		1,
		1,
	);
	expect(f).toMatchObject({
		code: "event_gap",
		generation: 1,
		authorityEpoch: 1,
		lastCursor: batch.receipt.seq,
	});
	expect(JSON.stringify(f)).not.toContain("secret");
	expect(
		observationFailure(
			store,
			coding,
			"task",
			new Error("disk secret /path"),
			1,
			1,
		).code,
	).toBe("observation_unknown");
});

test("a focused read resumes one reference but keeps the snapshot and the observation's meaning", async () => {
	const { reader } = await run("longmsg", true);
	const base = await reader.inspect("task", signal());
	const first = base.details!;
	const ref = first.messages[0]!.ref;
	const end = first.coverage.find((c) => c.ref === ref)!.ranges.at(-1)![1];
	const more = await reader.inspect("task", signal(), { ref, offset: end });
	const next = more.details!;
	const c = next.coverage.find((v) => v.ref === ref)!;
	// Coverage of this observation starts at the offset and is not merged with the earlier read.
	expect(c.ranges[0]![0]).toBe(end);
	expect(next.limitations).toContain("not_fully_observed");
	expect(more.snapshotHash).toBe(base.snapshotHash);
	expect(more.snapshotHash).not.toBeNull();
	expect(semanticObservationDigest(more)).toBe(semanticObservationDigest(base));
});

test("an unreadable body degrades to a limitation without changing what was said or the digest", async () => {
	const { store, coding, reader } = await run("normal");
	const base = await reader.inspect("task", signal());
	let calls = 0;
	const broken = codingObservationReader(store, {
		...coding,
		// The snapshot read (first) works; only the message body fails.
		readEvidence: async (...a: Parameters<typeof coding.readEvidence>) => {
			if (++calls > 1) throw new Error("runner_operation_failed");
			return coding.readEvidence(...a);
		},
	} as typeof coding);
	const o = await broken.inspect("task", signal());
	expect(o.details!.limitations).toContain("evidence_unreadable");
	expect(o.details!.messages).toEqual(base.details!.messages);
	expect(o.excerpt).toBe("");
	expect(semanticObservationDigest(o)).toBe(semanticObservationDigest(base));
});

test("an unreadable snapshot fails the observation instead of guessing the snapshot", async () => {
	const { store, coding } = await run("normal");
	const broken = codingObservationReader(store, {
		...coding,
		readEvidence: async () => {
			throw new Error("runner_operation_failed");
		},
	} as typeof coding);
	await expect(broken.inspect("task", signal())).rejects.toThrow(
		"runner_operation_failed",
	);
});
