import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	closeSync,
	ftruncateSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createRunner,
	publishSpec,
	pruneSpool,
	readReceipt,
} from "../src/core";
import { createEventWriter } from "../src/event-writer";
import {
	addSpoolBytes,
	atomicWrite,
	invalidateSpoolSize,
	readPrivate,
	runPath,
	spoolSize,
} from "../src/storage";
import { fixture, until } from "./support";

const hour = 3_600_000;

type Fixture = ReturnType<typeof fixture>;

async function finishedRun(f: Fixture) {
	const runner = createRunner(f.configPath, true);
	const spec = f.spec();
	publishSpec(f.config, "spec", spec);
	await runner.start("spec", spec.operationId, spec.executionId, false);
	await until(
		() => runner.inspect(spec.executionId, 0, 100, false),
		(r) => r.receipt.childrenStopped,
	);
	return { runner, spec };
}
/** Copies a finished run under a new execution id with a chosen deadline and state. */
function cloneRun(
	f: Fixture,
	from: string,
	deadlineAt: number,
	state = "exited",
) {
	const executionId = crypto.randomUUID();
	const src = runPath(f.config.spoolRoot, from);
	const dir = runPath(f.config.spoolRoot, executionId);
	mkdirSync(dir, { mode: 0o700 });
	const spec = JSON.parse(readPrivate(join(src, "spec.json")));
	atomicWrite(join(dir, "spec.json"), { ...spec, executionId, deadlineAt });
	const receipt = JSON.parse(readPrivate(join(src, "receipt.json")));
	atomicWrite(join(dir, "receipt.json"), {
		...receipt,
		executionId,
		state,
		updatedAt: Date.now(),
	});
	return executionId;
}

describe("spool retention", () => {
	test("only finished runs 24h past their deadline and not reserved are removed", async () => {
		const f = fixture();
		try {
			const { spec } = await finishedRun(f);
			const now = Date.now();
			const old = cloneRun(f, spec.executionId, now - 25 * hour);
			const recent = cloneRun(f, spec.executionId, now - 23 * hour);
			const running = cloneRun(f, spec.executionId, now - 25 * hour, "running");
			const reserved = cloneRun(f, spec.executionId, now - 25 * hour);
			atomicWrite(join(f.config.spoolRoot, "workspaces", "fixture.json"), {
				executionId: reserved,
			});
			atomicWrite(join(f.config.spoolRoot, "operations", "op-old.json"), {
				executionId: old,
				digest: "x",
			});
			atomicWrite(join(f.config.spoolRoot, "operations", "stop-old.json"), {
				executionId: old,
				generation: 1,
				reason: "cancel",
			});
			atomicWrite(join(f.config.spoolRoot, "operations", "op-keep.json"), {
				executionId: recent,
				digest: "x",
			});
			expect(pruneSpool(f.config, now)).toBe(1);
			const runs = readdirSync(join(f.config.spoolRoot, "runs"));
			expect(runs).not.toContain(old);
			expect(runs).toEqual(expect.arrayContaining([recent, running, reserved]));
			const ops = readdirSync(join(f.config.spoolRoot, "operations"));
			expect(ops).not.toContain("op-old.json");
			expect(ops).not.toContain("stop-old.json");
			expect(ops).toContain("op-keep.json");
		} finally {
			f.close();
		}
	});
	test("a spool full of expired runs does not refuse start", async () => {
		const f = fixture();
		try {
			const { spec, runner } = await finishedRun(f);
			const old = Date.now() - 25 * hour;
			for (let i = 0; i < 1000; i++) cloneRun(f, spec.executionId, old);
			const next = f.spec();
			publishSpec(f.config, "next", next);
			await runner.start("next", next.operationId, next.executionId, false);
			await until(
				() => runner.inspect(next.executionId, 0, 100, false),
				(r) => r.receipt.childrenStopped,
			);
		} finally {
			f.close();
		}
	});
	test("stop ignores an unrelated broken spec when the index exists", async () => {
		const f = fixture();
		try {
			const runner = createRunner(f.configPath, true);
			const spec = f.spec();
			publishSpec(f.config, "spec", spec);
			writeFileSync(join(f.config.spoolRoot, "specs", "x.json"), "{broken", {
				mode: 0o600,
			});
			const stopped = runner.stop(
				spec.executionId,
				1,
				crypto.randomUUID(),
				"cancel",
			);
			expect(stopped.state).toBe("stopped");
		} finally {
			f.close();
		}
	});
	test("a replay after the record was pruned is an expired authority", async () => {
		const f = fixture();
		const realNow = Date.now;
		try {
			const { spec, runner } = await finishedRun(f);
			// The finished run still holds its workspace reservation; release it.
			rmSync(join(f.config.spoolRoot, "workspaces", "fixture.json"));
			Date.now = () => realNow() + 26 * hour;
			expect(pruneSpool(f.config, Date.now())).toBe(1);
			expect(
				existsSync(
					join(f.config.spoolRoot, "operations", `${spec.operationId}.json`),
				),
			).toBe(false);
			publishSpec(f.config, "spec", spec);
			await expect(
				runner.start("spec", spec.operationId, spec.executionId, false),
			).rejects.toThrow("runner_authority_expired");
		} finally {
			Date.now = realNow;
			f.close();
		}
	});
	test("a symlink in the spool aborts the prune", async () => {
		const f = fixture();
		try {
			const { spec } = await finishedRun(f);
			const now = Date.now();
			const old = cloneRun(f, spec.executionId, now - 25 * hour);
			symlinkSync("/etc", join(runPath(f.config.spoolRoot, old), "link"));
			expect(() => pruneSpool(f.config, now)).toThrow("runner_spool_symlink");
			expect(existsSync(runPath(f.config.spoolRoot, old))).toBe(true);
		} finally {
			f.close();
		}
	});
});

describe("spool size cache", () => {
	test("re-walks only after the ttl or an invalidation", () => {
		const root = mkdtempSync(join(tmpdir(), "spool-size-"));
		try {
			writeFileSync(join(root, "a"), "12345");
			expect(spoolSize(root, 1000)).toBe(5);
			writeFileSync(join(root, "b"), "123");
			expect(spoolSize(root, 1000 + 59_000)).toBe(5);
			addSpoolBytes(root, 10);
			expect(spoolSize(root, 1000 + 59_000)).toBe(15);
			expect(spoolSize(root, 1000 + 61_000)).toBe(8);
			invalidateSpoolSize(root);
			writeFileSync(join(root, "c"), "1");
			expect(spoolSize(root, 1000 + 61_001)).toBe(9);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	test("the event writer does not re-walk the spool for every event", async () => {
		const f = fixture();
		try {
			const { spec } = await finishedRun(f);
			const receipt = readReceipt(f.config, spec.executionId);
			const path = join(f.root, "events-run");
			mkdirSync(join(path, "evidence"), { recursive: true });
			mkdirSync(join(path, "events"), { recursive: true });
			let over = 0;
			const event = createEventWriter({
				config: f.config,
				path,
				spec,
				receipt,
				maxRunBytes: 1024 * 1024 * 1024,
				save: () => {},
				overLimit: () => {
					over++;
				},
			});
			event("message", "first");
			// Written behind the writer's back: a re-walk would now see 250MB and refuse.
			const fd = openSync(join(f.config.spoolRoot, "huge"), "w", 0o600);
			ftruncateSync(fd, 250 * 1024 * 1024);
			closeSync(fd);
			for (let i = 0; i < 99; i++) event("message", `event ${i}`);
			expect(over).toBe(0);
			invalidateSpoolSize(f.config.spoolRoot);
			event("message", "after invalidation");
			expect(over).toBe(1);
		} finally {
			f.close();
		}
	});
});
