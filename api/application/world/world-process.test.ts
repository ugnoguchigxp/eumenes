import { expect, test } from "bun:test";
import {
	copyFileSync,
	existsSync,
	mkdtempSync,
	mkdirSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const helper = resolve(import.meta.dir, "world-process.fixture.ts");
async function child(dir: string, mode: string, point = "") {
	const p = Bun.spawn([process.execPath, helper, dir, mode, point], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const error = new Response(p.stderr).text();
	let output = "",
		killed = false;
	const timeout = setTimeout(() => p.kill("SIGKILL"), 20000);
	try {
		for await (const data of p.stdout) {
			output += new TextDecoder().decode(data);
			if (point && output.includes(`WORLD_CHECKPOINT:${point}\n`)) {
				killed = true;
				p.kill("SIGKILL");
			}
		}
		const code = await p.exited;
		const stderr = await error;
		if (point) {
			expect(killed, `${point}: ${output}\n${stderr}`).toBe(true);
			expect(code).not.toBe(0);
		} else expect(code, `${output}\n${stderr}`).toBe(0);
		const line = output.split("\n").find((s) => s.startsWith("WORLD_RESULT:"));
		return line ? JSON.parse(line.slice("WORLD_RESULT:".length)) : null;
	} finally {
		clearTimeout(timeout);
		p.kill();
	}
}
function copy(from: string, to: string) {
	mkdirSync(to);
	for (const name of [
		"db.sqlite3",
		"entry.json",
		"memory.jsonl",
		"world.jsonl",
	])
		if (existsSync(join(from, name)))
			copyFileSync(join(from, name), join(to, name));
}

test("SIGKILL at journal and forget commit boundaries recovers the full replay, including Memory confirmations and cursors", async () => {
	const dir = mkdtempSync(join(tmpdir(), "world-sigkill-"));
	try {
		const base = join(dir, "base");
		mkdirSync(base);
		await child(base, "init");
		const control = join(dir, "control");
		copy(base, control);
		const expected = await child(control, "run");
		expect(expected.assertions).toEqual([
			{ id: "keep", revision: 1, lifecycle: "candidate" },
			{ id: "keep", revision: 2, lifecycle: "active" },
		]);
		expect(
			expected.projection.map((r: { assertion_id: string }) => r.assertion_id),
		).toEqual(["keep"]);
		expect(expected.pending).toEqual({ n: 0 });
		expect(expected.externals.length).toBeGreaterThan(0);
		expect(
			expected.externals.every(
				(r: { state: string }) => r.state === "confirmed",
			),
		).toBe(true);
		// Complete Memory reconciliation before World ever accepted its intake.
		const memoryControl = join(dir, "memory-control");
		copy(base, memoryControl);
		const memoryReplayed = await child(memoryControl, "replay-memory");
		expect(memoryReplayed.projection).toEqual(expected.projection);
		// Restore the pre-forget database, retaining both actual journals.
		const restoreControl = join(dir, "restore-control");
		copy(control, restoreControl);
		copyFileSync(join(base, "db.sqlite3"), join(restoreControl, "db.sqlite3"));
		const restored = await child(restoreControl, "resume");
		expect(restored.projection).toEqual(expected.projection);
		expect(restored.gate).toBe(true);
		for (const point of [
			"memory_journal_appended",
			"journal_appended",
			"world_chunk",
			"world_call_done",
			"memory_batch",
			"feed_cursor_saved",
		]) {
			const path = join(dir, point);
			copy(base, path);
			await child(path, "run", point);
			// An uncommitted Memory apply requires a full restore. Compare that
			// path against the complete old-DB/new-journal replay, including its
			// intentional removal of unsettled inbox/candidate markers.
			const replay =
				point === "memory_journal_appended" ? memoryReplayed : expected;
			expect(await child(path, "resume"), point).toEqual(replay);
			expect(await child(path, "resume"), `${point} resend`).toEqual(replay);
		}
		for (const point of [
			"restore_begun",
			"restore_reconciled",
			"before_restore_finish",
			"restore_finished",
		]) {
			const path = join(dir, point);
			copy(control, path);
			copyFileSync(join(base, "db.sqlite3"), join(path, "db.sqlite3"));
			await child(path, "resume", point);
			expect(await child(path, "resume"), point).toEqual(restored);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 60000);
