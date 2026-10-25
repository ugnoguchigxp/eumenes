import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import { migrations } from "../repository";
import { migrations as settingsMigrations } from "../../settings";
import { createActivityReader } from "../service/activity";

let store: SqliteStore, dir: string;
afterEach(async () => {
	if (store) await store.close();
	if (dir) rmSync(dir, { recursive: true, force: true });
});

async function seed(
	rows: [
		subject: string,
		purpose: string,
		status: string,
		ended: number | null,
		reason?: string,
	][],
) {
	dir = mkdtempSync(join(tmpdir(), "attempt-activity-"));
	store = openStore(join(dir, "db"), [...settingsMigrations, ...migrations]);
	await store.write((db) =>
		rows.forEach(([subject, purpose, status, ended, reason], i) => {
			db.query(
				"INSERT INTO inference_requests(id,subject,purpose,snapshot,deadline) VALUES(?,?,?,?,?)",
			).run(`r${i}`, subject, purpose, "{}", 1);
			db.query(
				"INSERT INTO inference_attempts(id,request_id,source,status,reason,started,ended) VALUES(?,?,?,?,?,?,?)",
			).run(`a${i}`, `r${i}`, "larm", status, reason ?? null, 1, ended);
		}),
	);
	return createActivityReader(store);
}

test("groups attempts by purpose and ignores probes and cancellations", async () => {
	const reader = await seed([
		["conversation:1", "llm", "running", null],
		["conversation:2", "llm", "succeeded", 500],
		["conversation:3", "llm", "failed", 600, "inference_failed"],
		["conversation:4", "llm", "failed", 700, "cancelled"],
		["voice:3", "asr", "succeeded", 50],
		["probe:tts", "tts", "failed", 900, "larm_failed"],
	]);
	const activity = reader.attemptActivity(100);
	expect(activity.llm).toEqual({
		running: 1,
		lastSuccessAt: 500,
		lastFailure: { at: 600, reason: "inference_failed" },
	});
	// Outcomes before the window are not reported; probes are never service traffic.
	expect(activity.asr).toEqual({
		running: 0,
		lastSuccessAt: null,
		lastFailure: null,
	});
	expect(activity.tts.lastFailure).toBeNull();
});
