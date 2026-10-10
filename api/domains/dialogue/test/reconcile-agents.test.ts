/**
 * reconcileAgents must never leak a rejection, back off instead of spinning,
 * give up on a poison event (but not on transient store errors), and close()
 * must finish its cleanup even when a reconcile pass failed.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureLogging } from "../../../infrastructure/logger";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import type { AgentRuntime } from "../../agent-runtime";
import {
	migration as conversationMigration,
	avatarMotionMigration as conversationAvatarMotionMigration,
	answerDeliveryMigration as conversationAnswerDeliveryMigration,
	createConversationService,
} from "../../conversation";
import type { InferencePort } from "../../inference";
import type { LarmPort } from "../../larm";
import { createQueue, migration as queueMigration } from "../../queue";
import {
	createDialogueService,
	agentLinkMigration,
	migration,
	queueLinkMigration,
	worldStateMigration,
} from "..";

const dirs: string[] = [];
const stores: SqliteStore[] = [];
const rejections: unknown[] = [];
const onRejection = (reason: unknown) => rejections.push(reason);
process.on("unhandledRejection", onRejection);
afterEach(async () => {
	configureLogging({ level: "silent" });
	rejections.length = 0;
	for (const s of stores.splice(0)) await s.close().catch(() => {});
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
async function yieldTurns(n = 10) {
	for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}

type RootMode = (call: number) => unknown;

async function setup(root: RootMode, failed: { ids: string[] } = { ids: [] }) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-reconcile-"));
	dirs.push(dir);
	const store = openStore(join(dir, "db.sqlite3"), [
		conversationMigration,
		conversationAvatarMotionMigration,
		conversationAnswerDeliveryMigration,
		migration,
		queueMigration,
		queueLinkMigration,
		agentLinkMigration,
		worldStateMigration,
	]);
	stores.push(store);
	const logs: { event?: string; reason?: string }[] = [];
	configureLogging({
		level: "warn",
		destination: {
			write: (line: string) => {
				logs.push(JSON.parse(line));
			},
		},
	});
	const larm = {
		status: () => ({ state: "ready", capabilities: ["llm"] }),
		connect: async () => {},
		answer: async () => "回答",
		transcribe: async () => "",
		speak: async () => new Uint8Array(),
		close: async () => {},
	} as unknown as LarmPort & InferencePort;
	const conversation = createConversationService(store);
	const queue = createQueue(store);
	let calls = 0;
	let runId = "";
	const agents = {
		pendingEvents: () => [{ id: "event-1", root_run_id: runId }],
		byRootInTransaction: () => {
			calls += 1;
			return root(calls);
		},
		failAnswerInTransaction: (_db: unknown, id: string) => {
			failed.ids.push(id);
		},
	} as unknown as AgentRuntime;
	const dialogue = createDialogueService({
		store,
		conversation,
		larm,
		queue,
		agents,
	});
	const run = await dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "q",
	});
	runId = run.id;
	const link = () =>
		store.write((db) =>
			db
				.query("UPDATE dialogue_runs SET agent_task_id='t' WHERE id=?")
				.run(run.id),
		);
	return {
		store,
		dialogue,
		logs,
		calls: () => calls,
		runId: run.id,
		link: () =>
			store.write((db) =>
				db
					.query("UPDATE dialogue_runs SET agent_task_id='t' WHERE id=?")
					.run(run.id),
			),
		// Any commit wakes the reconciler; no timer is awaited.
		commit: async () => {
			await link();
			await yieldTurns();
		},
	};
}

test("a throwing event is logged, never rejected, and close() still completes", async () => {
	const h = await setup((n) => {
		if (n === 1) throw new Error("boom with free text");
		return null;
	});
	await h.link();
	await yieldTurns();
	expect(h.calls()).toBeGreaterThanOrEqual(1);
	expect(h.logs.some((l) => l.event === "dialogue.agent_event_failed")).toBe(
		true,
	);
	expect(
		h.logs.find((l) => l.event === "dialogue.agent_event_failed")?.reason,
	).toBe("agent_reconcile_failed");
	await h.dialogue.close();
	expect(rejections).toEqual([]);
});

test("transient store errors back off but never fail the run", async () => {
	const h = await setup(() => {
		throw new Error("database_closing");
	});
	await h.link();
	await yieldTurns();
	for (let i = 0; i < 10; i++) await h.commit();
	expect(h.calls()).toBeGreaterThanOrEqual(10);
	expect(h.dialogue.get(h.runId)?.status).not.toBe("failed");
	await h.dialogue.close();
	expect(rejections).toEqual([]);
});

test("a poison event fails the run after five failures", async () => {
	const failed = { ids: [] as string[] };
	const h = await setup(() => {
		throw new Error("poison");
	}, failed);
	await h.link();
	await yieldTurns();
	for (let i = 0; i < 8; i++) await h.commit();
	const run = h.dialogue.get(h.runId)!;
	expect(run.status).toBe("failed");
	expect(run.error).toBe("agent_event_failed");
	expect(failed.ids).toEqual([h.runId]);
	await h.dialogue.close();
	expect(rejections).toEqual([]);
});

test("a failing run synchronisation write does not reject", async () => {
	const h = await setup(() => ({
		state: "failed",
		error_code: "x",
		deadline: Date.now() + 60_000,
	}));
	const realWrite = h.store.write.bind(h.store);
	let writes = 0;
	// Writes after setup: 1 = link, 2 = event pass, 3 = run synchronisation.
	(h.store as { write: unknown }).write = (fn: never) =>
		++writes === 3 ? Promise.reject(new Error("sync_boom")) : realWrite(fn);
	await h.link();
	await yieldTurns();
	expect(h.logs.map((l) => l.event)).toContain(
		"dialogue.agent_run_sync_failed",
	);
	await h.dialogue.close();
	expect(rejections).toEqual([]);
});
