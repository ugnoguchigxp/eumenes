import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { openStore } from "../../../infrastructure/sqlite";
import { createQueue, migration } from "..";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function runChild(file: string, point: string, marker: string) {
	const child = Bun.spawn(
		[process.execPath, join(import.meta.dir, "crash-worker.ts"), file, point],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const reader = child.stdout.getReader();
	let seen = "";
	const deadline = Date.now() + 10_000;
	while (!seen.includes(marker) && Date.now() < deadline) {
		const { value, done } = await reader.read();
		if (done) break;
		seen += new TextDecoder().decode(value);
	}
	child.kill("SIGKILL");
	await child.exited;
	expect(seen).toContain(marker);
}
const handler = {
	kind: "crash.work",
	payloadVersions: [1],
	schema: z.object({}),
	recovery: "interrupt" as const,
	prepareInTransaction: () => ({ status: "ready" as const, input: null }),
	execute: () => new Promise<never>(() => {}),
	settleInTransaction: () => "applied" as const,
	cancelInTransaction: () => {},
};

test("process killed after commit but before claim: the job survives and runs after restart", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-crash-"));
	dirs.push(dir);
	const file = join(dir, "db.sqlite3");
	await runChild(file, "after-enqueue", "ENQUEUED");
	const store = openStore(file, [migration]); // owner lock was released by the killed process
	const queue = createQueue(store);
	queue.registerHandler(handler);
	expect(queue.list().items[0]?.state).toBe("queued");
	expect(await queue.recover()).toBe(0);
	await queue.tick();
	expect(queue.list().items[0]?.state).toBe("running");
	await queue.close(20);
	await store.close();
});

test("process killed while a handler is running: restart marks it interrupted with a closed attempt", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-crash-"));
	dirs.push(dir);
	const file = join(dir, "db.sqlite3");
	await runChild(file, "running", "EXECUTING");
	const store = openStore(file, [migration]);
	const queue = createQueue(store);
	queue.registerHandler(handler);
	const before = queue.list().items[0];
	expect(before?.state).toBe("running");
	expect(await queue.recover()).toBe(1);
	const after = queue.list().items[0];
	expect(after?.state).toBe("interrupted");
	expect(after?.errorCode).toBe("backend_restarted");
	expect(
		queue
			.listAttempts(after?.id ?? "")
			.map((a) => [a.outcome, a.endedAt !== null]),
	).toEqual([["interrupted", true]]);
	// not claimable again, and a second recover is a no-op
	await queue.tick();
	expect(queue.list().items[0]?.state).toBe("interrupted");
	expect(await queue.recover()).toBe(0);
	await store.close();
});

test("second process cannot own the same database while the first lives", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-crash-"));
	dirs.push(dir);
	const file = join(dir, "db.sqlite3");
	const store = openStore(file, [migration]);
	expect(() => openStore(file, [migration])).toThrow("database_writer_owned");
	await store.close();
});
