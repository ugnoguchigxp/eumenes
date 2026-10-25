import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import type { StepId, UnitSlot } from "../contracts";
import {
	closeUnit,
	insertDecision,
	insertUnit,
	setUnitJob,
} from "../repository";
import { createActivity, STEWARD_REPORT_LIMIT } from "../service/activity";
import { registerSteward } from "..";
import type { StewardService } from "../service";
import { migrations } from "./steward.fixture";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** 2026-10-25 13:55 JST. */
const NOW = Date.parse("2026-10-25T04:55:00.000Z");

function setup() {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-steward-activity-"));
	const store = openStore(join(dir, "db.sqlite3"), migrations);
	cleanups.push(async () => {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const running = new Set<string>();
	const logFile = join(dir, "api.jsonl");
	const activity = createActivity({
		store,
		nowMs: () => NOW,
		logFile: () => logFile,
		queue: {
			enqueueInTransaction: () => {
				throw new Error("unused");
			},
			getInTransaction: (_db, id) => ({
				state: running.has(id) ? "running" : "queued",
			}),
		},
	});
	return { store, running, logFile, activity };
}

let seq = 0;
/** One unit of a slot; closed with an error code when `state` is not open. */
async function unit(
	store: SqliteStore,
	input: {
		slot: UnitSlot;
		step: StepId;
		state: "open" | "applied" | "failed" | "stale";
		at?: string;
		code?: string | null;
		attempt?: number;
		conversationId?: string;
		/** false: the job's decision is gone (pruned). */
		decision?: boolean;
	},
) {
	const id = `u${++seq}`;
	const jobId = `job-${seq}-0000-0000-0000-000000000000`;
	const conversationId = input.conversationId ?? "main";
	await store.write((db) => {
		insertUnit(db, {
			id,
			conversationId,
			kind: input.slot === "world" ? "world_events" : "events",
			step: input.step,
			slot: input.slot,
			targets: {},
			attempt: input.attempt ?? 0,
			createdAt: input.at ?? "2026-10-25T04:00:00.000Z",
		});
		setUnitJob(db, id, jobId);
		if (input.state === "open") return;
		closeUnit(db, id, input.state, input.at ?? "2026-10-25T04:00:00.000Z");
		if (input.decision === false) return;
		insertDecision(db, {
			conversationId,
			jobId,
			step: input.step,
			createdAt: input.at ?? "2026-10-25T04:00:00.000Z",
			output: null,
			results: null,
			windowVersionBefore: null,
			windowVersionAfter: null,
			durationMs: null,
			outputTokens: null,
			errorCode: input.code ?? null,
		});
	});
	return jobId;
}

test("a slot is lit only while its open unit's job runs", async () => {
	const { store, running, activity } = setup();
	const reflect = await unit(store, {
		slot: "reflect",
		step: "curate-memory",
		state: "open",
	});
	await unit(store, { slot: "world", step: "curate-world", state: "open" });
	expect(activity.activity("main")).toEqual({
		running: false,
		slots: [],
		errors: [],
	});
	running.add(reflect);
	expect(activity.activity("main")).toMatchObject({
		running: true,
		slots: ["reflect"],
	});
	expect(activity.activity("other").running).toBe(false);
});

test("a slot fails while its last closed unit failed for a reason other than a LARM yield", async () => {
	const { store, activity } = setup();
	await unit(store, {
		slot: "world",
		step: "curate-world",
		state: "failed",
		code: "cloud_agent_billing_error",
		at: "2026-10-25T04:51:33.982Z",
	});
	await unit(store, {
		slot: "reflect",
		step: "curate-memory",
		state: "failed",
		code: "larm_preempted",
		at: "2026-10-25T04:31:14.271Z",
	});
	await unit(store, {
		slot: "maintenance",
		step: "consolidate-memory",
		state: "failed",
		code: "invalid_output",
		at: "2026-10-25T04:10:00.000Z",
	});
	await unit(store, {
		slot: "maintenance",
		step: "consolidate-memory",
		state: "applied",
		at: "2026-10-25T04:20:00.000Z",
	});
	expect(activity.activity("main").errors).toEqual([
		{
			slot: "world",
			step: "curate-world",
			code: "cloud_agent_billing_error",
			at: "2026-10-25T04:51:33.982Z",
		},
	]);
	// A LARM yield after it does not hide it.
	await unit(store, {
		slot: "world",
		step: "curate-world",
		state: "failed",
		code: "larm_preempted",
		at: "2026-10-25T04:51:50.000Z",
	});
	expect(activity.activity("main").errors).toMatchObject([
		{ slot: "world", code: "cloud_agent_billing_error" },
	]);
	// A later success of the same slot clears it.
	await unit(store, {
		slot: "world",
		step: "curate-world",
		state: "applied",
		at: "2026-10-25T04:52:00.000Z",
	});
	expect(activity.activity("main").errors).toEqual([]);
	// A failure whose decision was pruned still shows.
	await unit(store, {
		slot: "episode",
		step: "summarize",
		state: "failed",
		decision: false,
		at: "2026-10-25T04:53:00.000Z",
	});
	expect(activity.activity("main").errors).toMatchObject([
		{ slot: "episode", code: "unknown" },
	]);
});

test("the error report names the failing step with IDs, codes and the job's log, and nothing else", async () => {
	const { store, logFile, activity } = setup();
	expect(await activity.errorReport("main")).toBeNull();
	// Yesterday's failure (JST) is not counted as today's.
	await unit(store, {
		slot: "world",
		step: "curate-world",
		state: "failed",
		code: "cloud_agent_billing_error",
		at: "2026-10-24T14:00:00.000Z",
	});
	await unit(store, {
		slot: "world",
		step: "curate-world",
		state: "failed",
		code: "cloud_agent_billing_error",
		at: "2026-10-25T04:50:13.055Z",
	});
	// A yield of the same step is not counted.
	await unit(store, {
		slot: "world",
		step: "curate-world",
		state: "failed",
		code: "larm_preempted",
		at: "2026-10-25T04:30:00.000Z",
	});
	const job = await unit(store, {
		slot: "world",
		step: "curate-world",
		state: "failed",
		code: "cloud_agent_billing_error",
		attempt: 2,
		at: "2026-10-25T04:51:33.982Z",
	});
	const line = (fields: Record<string, unknown>) =>
		JSON.stringify({ service: "eumenes", jobId: job, ...fields });
	writeFileSync(
		logFile,
		[
			line({
				level: "info",
				time: "2026-10-25T13:51:30.000+09:00",
				component: "queue",
				event: "queue.claimed",
			}),
			line({
				level: "warn",
				time: "2026-10-25T13:51:33.977+09:00",
				component: "inference",
				event: "inference.attempt_failed",
				reason: "cloud_agent_billing_error",
				source: "cloud",
				errorFrames: [
					`${process.cwd()}/api/domains/inference/adapters/cloud-agents.ts:658:13`,
				],
				prompt: "会話本文は出さない",
			}),
			line({
				level: "warn",
				time: "2026-10-25T13:51:33.984+09:00",
				component: "steward",
				event: "steward.unit_failed",
				stepId: "curate-world",
				reason: "cloud_agent_billing_error",
			}),
		].join("\n") + "\n",
	);
	const text = (await activity.errorReport("main"))!;
	expect(text).toBe(
		[
			"# Eumenes エラーレポート（メモリー整理）",
			"これはバックグラウンドのメモリー担当（steward）の失敗の診断です。会話本文・設定・認証情報は含みません。",
			"原因の推定と、確認すべきコード・ログを示してください。",
			"",
			"## 概要",
			"- 会話: main",
			"- 失敗中の処理: 世界の記録（curate-world）",
			"",
			"## 世界の記録（curate-world）",
			`- 最終失敗: 2026-10-25 13:51:33 JST  attempt: 2  job: ${job.slice(0, 8)}`,
			"- error_code: cloud_agent_billing_error",
			"- 直近の失敗: 2件（本日）",
			"- ログ:",
			"  - 13:51:33 WARN inference inference.attempt_failed  reason: cloud_agent_billing_error  source: cloud",
			"    場所: api/domains/inference/adapters/cloud-agents.ts:658:13",
			"  - 13:51:33 WARN steward steward.unit_failed  stepId: curate-world  reason: cloud_agent_billing_error",
			"",
			"## 調べ方",
			`- bun run logs -- --level warn --id ${job}`,
			"- docs/logging.md",
		].join("\n"),
	);
	expect(text).not.toContain("会話本文は出さない");
	expect(text.length).toBeLessThanOrEqual(STEWARD_REPORT_LIMIT);
});

test("activity and the error report are read over HTTP", async () => {
	const { store, activity } = setup();
	const app = new Hono();
	registerSteward(app, activity as unknown as StewardService);
	app.onError((error, c) => c.json({ error: error.message }, 400));
	expect((await app.request("/api/steward/activity")).status).toBe(400);
	const idle = await app.request("/api/steward/activity?conversationId=main");
	expect(await idle.json()).toEqual({ running: false, slots: [], errors: [] });
	const none = await app.request(
		"/api/steward/error-report?conversationId=main",
	);
	expect(none.status).toBe(404);
	expect(await none.json()).toEqual({
		error: "steward_error_report_not_found",
	});
	await unit(store, {
		slot: "world",
		step: "curate-world",
		state: "failed",
		code: "cloud_agent_billing_error",
	});
	const report = await app.request(
		"/api/steward/error-report?conversationId=main",
	);
	expect(report.status).toBe(200);
	expect(((await report.json()) as { text: string }).text).toContain(
		"cloud_agent_billing_error",
	);
});
