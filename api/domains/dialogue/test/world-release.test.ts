/**
 * Every settle path that does not adopt a World-backed answer must release
 * the World context's input dependencies (report invalidated, Memory refusing
 * the adoption), and a busy pre-send check ends the run with a code, never a
 * send. Stub ports: the real Broker is covered in world/test.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import type { AgentRuntime, AnswerTicket } from "../../agent-runtime";
import {
	migration as conversationMigration,
	avatarMotionMigration as conversationAvatarMotionMigration,
	answerDeliveryMigration as conversationAnswerDeliveryMigration,
	createConversationService,
} from "../../conversation";
import type { InferencePort } from "../../inference";
import type { LarmPort } from "../../larm";
import type { MemoryService } from "../../memory";
import { createQueue, migration as queueMigration } from "../../queue";
import {
	createDialogueService,
	agentLinkMigration,
	migration,
	queueLinkMigration,
	worldStateMigration,
	type WorldContextPort,
	type WorldContextVerdict,
} from "..";

const dirs: string[] = [];
const stores: SqliteStore[] = [];
afterEach(async () => {
	for (const s of stores.splice(0)) await s.close().catch(() => {});
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
async function until(cond: () => boolean) {
	for (let i = 0; i < 400; i++) {
		if (cond()) return;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error("condition not reached");
}

function setup(
	options: {
		reportValid?: boolean;
		memoryAdopts?: boolean;
		verdict?: WorldContextVerdict;
	} = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-world-release-"));
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
	let sends = 0;
	const larm: LarmPort & InferencePort = {
		status: () => ({ state: "ready", capabilities: ["llm"] }),
		connect: async () => {},
		answer: async () => {
			sends += 1;
			return "回答";
		},
		transcribe: async () => "",
		speak: async () => new Uint8Array(),
		close: async () => {},
	};
	const conversation = createConversationService(store);
	const queue = createQueue(store);
	const ticket: AnswerTicket = {
		taskId: "t",
		eventId: "event-1",
		revision: 1,
		dataEpoch: 0,
		reportTaskId: "c",
		reportEpoch: 3,
		reportDigest: null,
		projection: null,
		failureCode: null,
	};
	const agents = {
		startInTransaction(
			db: any,
			input: { rootRunId: string; deadline: number },
		) {
			const { job } = queue.enqueueInTransaction(db, {
				scope: "dialogue",
				kind: "dialogue.generate",
				dedupeKey: input.rootRunId,
				payload: { runId: input.rootRunId },
				subjectRef: input.rootRunId,
				lane: "interactive",
				resourceKey: "inference.llm",
				maxAttempts: 1,
				concurrencyKey: "conversation:main",
			});
			return { taskId: "t", jobId: job.id };
		},
		prepareAnswerInTransaction: () => ticket,
		completeAnswerInTransaction: () => {},
		validAnswerInTransaction: () => options.reportValid !== false,
		failAnswerInTransaction: () => {},
		pendingEvents: () => [],
		byRootInTransaction: () => null,
	} as unknown as AgentRuntime;
	const memory = {
		prepareInTransaction: () => ({
			status: "ready",
			block: "memory-block",
			view: {},
		}),
		settleInTransaction: () =>
			options.memoryAdopts === false
				? { ok: false, reason: "memory_stale" }
				: { ok: true },
		discardUsageInTransaction: () => {},
	} as unknown as MemoryService;
	const released: string[] = [];
	const recorded: string[] = [];
	const worldContext: WorldContextPort = {
		prepareInTransaction: () => ({
			status: "ready",
			block: "world-block",
			context: {},
		}),
		checkBeforeSend: async () => options.verdict ?? { ok: true },
		validateInTransaction: () => ({ ok: true }),
		recordUsageInTransaction: (_db, input) => {
			recorded.push(input.runId);
		},
		releaseInTransaction: (_db, runId) => {
			released.push(runId);
		},
	};
	const dialogue = createDialogueService({
		store,
		conversation,
		larm,
		queue,
		agents,
		memory,
		worldContext,
	});
	queue.start();
	return {
		dialogue,
		queue,
		released,
		recorded,
		sends: () => sends,
		async run() {
			const run = await dialogue.submit({
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text: "q",
			});
			await until(() =>
				["completed", "failed", "cancelled"].includes(
					dialogue.get(run.id)?.status ?? "",
				),
			);
			return dialogue.get(run.id)!;
		},
	};
}

test("a report invalidated at adoption releases the World context's input dependencies", async () => {
	const h = setup({ reportValid: false });
	const done = await h.run();
	expect(done.status).toBe("failed");
	expect(done.error).toBe("report_invalidated");
	expect(h.released).toEqual([done.id]);
	expect(h.recorded).toEqual([]);
	await h.queue.close(100);
});

test("a Memory adoption refusal releases the World context's input dependencies and records no usage", async () => {
	const h = setup({ memoryAdopts: false });
	const done = await h.run();
	expect(done.status).toBe("failed");
	expect(done.error).toBe("memory_stale");
	expect(h.released).toEqual([done.id]);
	expect(h.recorded).toEqual([]);
	await h.queue.close(100);
});

test("an adopted answer keeps its dependencies (control)", async () => {
	const h = setup();
	const done = await h.run();
	expect(done.status).toBe("completed");
	expect(h.released).toEqual([]);
	expect(h.recorded).toEqual([done.id]);
	await h.queue.close(100);
});

test("a pre-send check that cannot run (busy writer) sends nothing and ends the run with a content-free code", async () => {
	const h = setup({
		verdict: { ok: false, reason: "world_check_unavailable", retryable: true },
	});
	const done = await h.run();
	expect(done.status).toBe("failed");
	expect(done.error).toBe("world_check_unavailable");
	expect(h.sends()).toBe(0);
	expect(h.released).toEqual([done.id]);
	await h.queue.close(100);
});
