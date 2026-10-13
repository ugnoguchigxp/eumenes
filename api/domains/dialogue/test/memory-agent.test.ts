import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrations as memoryPackageMigrations } from "eumenes-memory/sqlite";
import { configureLogging } from "../../../infrastructure/logger";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import {
	migration as conversationMigration,
	avatarMotionMigration,
	answerDeliveryMigration,
	createConversationService,
} from "../../conversation";
import {
	createContinuityService,
	migration as continuityMigration,
	shortTermMigration,
} from "../../continuity";
import {
	createDialogueService,
	migration as dialogueMigration,
	queueLinkMigration,
} from "..";
import type { LarmPort } from "../../larm";
import { createQueue, migration as queueMigration } from "../../queue";
import {
	createMemoryService,
	migration as memoryMigration,
	contextWindowMigration,
	agentHardeningMigration,
	turnVectorsMigration,
} from "../../memory";
import { fakeInference, until, type AgentData } from "./memory-agent.fixture";

const MIGRATIONS = [
	conversationMigration,
	avatarMotionMigration,
	answerDeliveryMigration,
	dialogueMigration,
	queueMigration,
	queueLinkMigration,
	continuityMigration,
	shortTermMigration,
	memoryMigration,
	contextWindowMigration,
	agentHardeningMigration,
	turnVectorsMigration,
	...memoryPackageMigrations,
];
const TERMINAL = ["completed", "failed", "cancelled", "expired", "interrupted"];
const open: Array<() => Promise<void>> = [];
afterEach(async () => {
	configureLogging({ level: "silent" });
	for (const close of open.splice(0)) await close();
});

async function setup(
	options: {
		answer?: () => Promise<string>;
		queueLimits?: { total: number; background: number; scope: number };
	} = {},
) {
	configureLogging({ level: "silent" });
	const dir = mkdtempSync(join(tmpdir(), "eumenes-memory-agent-dialogue-"));
	const seen: Array<{ role: string; content: string }[]> = [];
	const larm: LarmPort = {
		status: () => ({ state: "ready", capabilities: ["llm"] }),
		connect: async () => {},
		answer: async (messages) => {
			seen.push(messages.map((m) => ({ ...m })));
			return options.answer ? options.answer() : "了解です";
		},
		transcribe: async () => "",
		speak: async () => new Uint8Array(),
		close: async () => {},
	};
	const store: SqliteStore = openStore(join(dir, "db.sqlite3"), MIGRATIONS);
	const conversation = createConversationService(store);
	const continuity = createContinuityService(store);
	const queue = createQueue(store, {
		resources: { "inference.llm": 1, "inference.aux": 2 },
		...(options.queueLimits ? { limits: options.queueLimits } : {}),
	});
	const inference = fakeInference();
	const memory = createMemoryService(store, conversation, continuity, {
		journalPath: join(dir, "journal.jsonl"),
		queue,
		inference: inference.port,
	});
	await memory.recover();
	queue.registerHandler(memory.agentHandler());
	const dialogue = createDialogueService({
		store,
		conversation,
		larm,
		queue,
		memory,
	});
	queue.start();
	const jobs = () => queue.list({ scope: "memory" }).items;
	const harness = {
		store,
		queue,
		dialogue,
		memory,
		inference,
		seen,
		jobs,
		submit: (text: string, requestId = crypto.randomUUID()) =>
			dialogue.submit({ requestId, conversationId: "main", text }),
		async ask(text: string) {
			const run = await harness.submit(text);
			await until(() => TERMINAL.includes(dialogue.get(run.id)?.status ?? ""));
			return dialogue.get(run.id)!;
		},
		async agentsSettled(count: number) {
			await until(
				() =>
					jobs().length >= count &&
					jobs().every((job) => TERMINAL.includes(job.state)),
				`${count} memory jobs settled`,
			);
		},
	};
	open.push(async () => {
		await queue.close(100).catch(() => {});
		await store.close().catch(() => {});
		rmSync(dir, { recursive: true, force: true });
	});
	return harness;
}
const answer = (...ops: Array<Record<string, unknown>>) =>
	JSON.stringify({ ops });
const noticeIn = (messages: Array<{ role: string; content: string }>) =>
	messages.find(
		(m) =>
			m.role === "system" && m.content.includes("記憶の担当からの連絡です"),
	);

test("a refused request reaches the next answer's context once, and an adopted answer clears it", async () => {
	const h = await setup();
	h.inference.state.script = (data: AgentData) =>
		data.turns.some((turn) => turn.text.includes("お茶派"))
			? answer({
					type: "remember",
					turn: "u1",
					requested: true,
					kind: "preference",
					semanticKey: "drink.tea",
					text: "コーヒー派",
					quote: "コーヒー派",
				})
			: answer();
	await h.ask("お茶派なの、覚えておいて");
	// One job at acceptance (the user's words), one at adoption (the answer).
	await h.agentsSettled(2);
	expect(h.memory.list(true)).toHaveLength(0);
	expect(noticeIn(h.seen[0]!)).toBeUndefined();
	await h.ask("こんにちは");
	const carried = noticeIn(h.seen[1]!);
	expect(carried?.content).toContain(
		"「お茶派なの、覚えておいて」の記憶の依頼は保存できませんでした（発言を確認できませんでした）。",
	);
	// Right before the user's last words, after the history.
	expect(h.seen[1]!.at(-1)).toMatchObject({
		role: "user",
		content: "こんにちは",
	});
	expect(h.seen[1]!.indexOf(carried!)).toBe(h.seen[1]!.length - 2);
	await h.agentsSettled(4);
	await h.ask("ありがとう");
	expect(noticeIn(h.seen[2]!)).toBeUndefined();
});

test("a resent request and a scheduled prompt start no agent", async () => {
	const h = await setup();
	h.inference.state.script = () => answer();
	const requestId = crypto.randomUUID();
	const run = await h.submit("こんにちは", requestId);
	await until(() => TERMINAL.includes(h.dialogue.get(run.id)?.status ?? ""));
	await h.agentsSettled(2);
	// Acceptance and adoption each started one; a settle may queue an empty successor behind them.
	const started = h.jobs().length;
	const inferred = h.inference.state.calls.length;
	const again = await h.submit("こんにちは", requestId);
	expect(again.id).toBe(run.id);
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(h.jobs()).toHaveLength(started);
	// A scheduled prompt is the system's: neither its acceptance nor its answer starts the agent.
	const materialized = await h.store.write((db) =>
		h.dialogue.promptTarget.materializeInTransaction(db, {
			occurrenceId: "occurrence-1",
			scheduleId: "schedule-1",
			payload: { conversationId: "main", text: "定時の確認" },
		} as never),
	);
	await until(() => {
		const current = h.dialogue.get(materialized.subjectRef as string);
		return TERMINAL.includes(current?.status ?? "");
	});
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(h.jobs()).toHaveLength(started);
	expect(h.inference.state.calls).toHaveLength(inferred);
});

test("memory off starts no agent", async () => {
	const h = await setup();
	await h.memory.setEnabled(false);
	await h.ask("こんにちは");
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(h.jobs()).toHaveLength(0);
});

test("the agent infers on its own resource: the next answer does not wait for it", async () => {
	const h = await setup();
	let release!: () => void;
	h.inference.state.gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	h.inference.state.script = () => answer();
	const first = await h.ask("最初の発話");
	expect(first.status).toBe("completed");
	await until(() => h.inference.state.calls.length === 1, "agent inference");
	expect(h.jobs().some((job) => job.state === "running")).toBe(true);
	// The agent is still inferring while two more answers complete.
	expect((await h.ask("次の発話")).status).toBe("completed");
	expect((await h.ask("その次の発話")).status).toBe("completed");
	expect(h.inference.state.calls).toHaveLength(1);
	const status = h.queue.stats();
	expect(status.resources["inference.aux"]).toMatchObject({ capacity: 2 });
	release();
	await h.agentsSettled(3);
});

test("a run cancelled before it answered still has its words read at acceptance", async () => {
	let release!: () => void;
	const h = await setup({
		answer: () =>
			new Promise<string>((resolve) => {
				release = () => resolve("遅い回答");
			}),
	});
	h.inference.state.script = () => answer();
	const run = await h.submit("毎朝コーヒーを飲んでる");
	await until(() => h.seen.length === 1, "generation started");
	await h.dialogue.cancel(run.id);
	release();
	await until(() => h.inference.state.calls.length >= 1, "agent inference");
	expect(h.inference.state.calls[0]?.data.turns).toMatchObject([
		{ label: "u1", role: "user", text: "毎朝コーヒーを飲んでる" },
	]);
	await h.agentsSettled(1);
	expect(h.dialogue.get(run.id)?.status).toBe("cancelled");
});

test("a full queue for the agent never undoes the user's message or the answer", async () => {
	// No room for background jobs at all: the dialogue's own (interactive) jobs still fit.
	const h = await setup({
		queueLimits: { total: 1024, background: 0, scope: 128 },
	});
	h.inference.state.script = () => answer();
	const run = await h.ask("こんにちは");
	expect(run.status).toBe("completed");
	expect(h.jobs()).toHaveLength(0);
	expect(h.inference.state.calls).toHaveLength(0);
	const stored = h.store.read(
		(db) =>
			db.query("SELECT COUNT(*) AS n FROM messages").get() as { n: number },
	);
	expect(stored.n).toBe(2);
});

test("a scheduled prompt is never learned from, whatever the model proposes", async () => {
	const h = await setup();
	// A conversation the agent already knows, read from its start.
	await h.store.write((db) =>
		db
			.query(
				"INSERT INTO memory_agent_cursor (conversation_id, last_ordinal, failures) VALUES ('main', 0, 0)",
			)
			.run(),
	);
	h.inference.state.script = () =>
		answer({
			type: "remember",
			turn: "u1",
			requested: true,
			kind: "preference",
			semanticKey: "food.spicy",
			text: "辛いものが好き",
			quote: "辛いものが好き",
		});
	const scheduled = await h.store.write((db) =>
		h.dialogue.promptTarget.materializeInTransaction(db, {
			occurrenceId: "occurrence-9",
			scheduleId: "schedule-9",
			payload: { conversationId: "main", text: "私は辛いものが好きです" },
		} as never),
	);
	await until(() =>
		TERMINAL.includes(
			h.dialogue.get(scheduled.subjectRef as string)?.status ?? "",
		),
	);
	expect(h.jobs()).toHaveLength(0);
	// A real utterance follows. The scheduled prompt lies in the unread part but is dropped from what the model sees.
	await h.ask("こんにちは");
	await h.agentsSettled(2);
	const texts = h.inference.state.calls.flatMap((call) =>
		call.data.turns.map((turn) => turn.text),
	);
	expect(texts).toContain("こんにちは");
	expect(texts).not.toContain("私は辛いものが好きです");
	expect(h.memory.list(true)).toHaveLength(0);
});
