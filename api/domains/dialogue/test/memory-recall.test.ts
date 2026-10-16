import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrations as memoryPackageMigrations } from "eumenes-memory/sqlite";
import { sha256Hex } from "../../../infrastructure/digest";
import { packVector, vectorSpaceKey } from "../../../infrastructure/vector";
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
	itemSourceMigration,
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
	stewardLedgersMigration,
	forgetClosureMigration,
	seedImportMigration,
} from "../../memory";
import { saveItem } from "./memory-seed";
import { conversationPolicy } from "../service/conversation-tools";
import type {
	QueryVector,
	ToolchainRoutingPort,
} from "../contracts/toolchains";

const MIGRATIONS = [
	conversationMigration,
	avatarMotionMigration,
	answerDeliveryMigration,
	dialogueMigration,
	queueMigration,
	queueLinkMigration,
	continuityMigration,
	shortTermMigration,
	itemSourceMigration,
	memoryMigration,
	contextWindowMigration,
	agentHardeningMigration,
	turnVectorsMigration,
	stewardLedgersMigration,
	forgetClosureMigration,
	seedImportMigration,
	...memoryPackageMigrations,
];
const SPACE = {
	modelId: "test-embed",
	revision: "1",
	artifactDigest: "digest",
	dimension: 3,
};
const KYOTO = [1, 0, 0];
const OTHER = [0, 0, 1];
type Message = { role: string; content: string };
const RECALL_HEADER = "past_turns_reference_data";
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean) {
	for (let i = 0; i < 300; i++) {
		if (check()) return;
		await pause(10);
	}
	throw new Error("timeout");
}
const open: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of open.splice(0)) await close();
});

/** Routing that offers nothing but embeds the request as the test says (none: the provider is unavailable). */
function routing(
	query: () => QueryVector | undefined,
	offered = false,
): ToolchainRoutingPort {
	const card = {
		revisionId: "toolchain:web.search@1",
		id: "web.search",
		functionName: "web_search",
		title: "Web検索",
		summary: "公開情報の確認",
		useWhen: ["確認"],
		redirects: [],
		score: { rank: 1, ftsRank: null, similarity: null, fromHistory: false },
	};
	return {
		embedQuery: async () => query(),
		routeInTransaction: () => ({
			cards: offered ? [card] : [],
			past: [],
			retrieval: "none",
		}),
		catalogInTransaction: () => [],
		resolveInTransaction: () => {
			throw new Error("unexpected_resolve");
		},
		commandSetInTransaction: () => {
			throw new Error("unexpected_command");
		},
		recordSelectionInTransaction: () => "selection",
		linkTaskInTransaction: () => {},
		settleSelectionInTransaction: () => {},
		requestOfRunInTransaction: () => undefined,
	};
}

async function setup(
	options: {
		/** The answer is streamed in parts. */
		stream?: boolean;
		/** The model answers with a toolchain call instead of text. */
		operation?: boolean;
	} = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-memory-recall-"));
	const seen: Message[][] = [];
	const during: { current: (() => Promise<void>) | undefined } = {
		current: undefined,
	};
	const query: { current: QueryVector | undefined } = {
		current: { space: SPACE, vector: KYOTO },
	};
	const larm: LarmPort = {
		status: () => ({ state: "ready", capabilities: ["llm"] }),
		connect: async () => {},
		...(options.operation
			? {
					requestFor: () => "request-1",
					setContextPolicyInTransaction: () => {},
					validateReceiptInTransaction: () => true,
					executeRequest: async (_id: string, messages: Message[]) => {
						seen.push(messages.map((m) => ({ ...m })));
						await during.current?.();
						return {
							requestId: "request-1",
							attemptId: "1",
							value: "",
							toolCalls: [
								{
									id: "call",
									name: "web_search",
									arguments: JSON.stringify({ request: "京都の天気" }),
								},
							],
						};
					},
				}
			: {}),
		...(options.stream
			? {
					answerStream: async (
						messages: Message[],
						_signal: unknown,
						onDelta: (text: string) => void,
					) => {
						seen.push(messages.map((m) => ({ ...m })));
						for (const part of ["了解", "です"]) {
							onDelta(part);
							await pause(5);
						}
						await pause(30);
						return "了解です";
					},
				}
			: {}),
		answer: async (messages) => {
			seen.push(messages.map((m) => ({ ...m })));
			await during.current?.();
			return "了解です";
		},
		transcribe: async () => "",
		speak: async () => new Uint8Array(),
		close: async () => {},
	};
	const store: SqliteStore = openStore(join(dir, "db.sqlite3"), MIGRATIONS);
	const conversation = createConversationService(store);
	const continuity = createContinuityService(store);
	const memory = createMemoryService(store, conversation, continuity, {
		journalPath: join(dir, "journal.jsonl"),
	});
	await memory.recover();
	const queue = createQueue(store);
	queue.start();
	const dialogue = createDialogueService({
		store,
		conversation,
		larm,
		queue,
		memory,
		toolchains: routing(() => query.current, options.operation),
		// A conversation operation needs a toolchain runtime to exist; the stub refuses every toolchain.
		...(options.operation
			? { music: { resultInTransaction: () => undefined } as never }
			: {}),
	});
	const harness = {
		store,
		conversation,
		memory,
		dialogue,
		seen,
		during,
		query,
		async ask(text: string) {
			const run = await dialogue.submit({
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text,
			});
			await until(() =>
				["completed", "failed", "cancelled"].includes(
					dialogue.get(run.id)?.status ?? "",
				),
			);
			return dialogue.get(run.id)!;
		},
		/** A vector for a message, as the memory agent would have stored it. */
		putVector: (
			messageId: string,
			vector: number[],
			space: typeof SPACE = SPACE,
		) =>
			store.write((db) => {
				const found = conversation.messageInTransaction(db, messageId)!;
				db.query(
					"INSERT OR REPLACE INTO memory_turn_vector (message_id, conversation_id, ordinal, space, vector, digest, created_at) VALUES (?,?,?,?,?,?,?)",
				).run(
					messageId,
					found.message.conversationId,
					found.ordinal,
					vectorSpaceKey(space),
					packVector(vector),
					sha256Hex(found.message.text),
					"2026-10-13T12:00:00.000Z",
				);
			}),
		edit: (messageId: string, text: string) =>
			store.write((db) => {
				db.query("UPDATE messages SET text = ? WHERE id = ?").run(
					text,
					messageId,
				);
			}),
		async seedState() {
			const run = await harness.ask("私は辛いものが好きです");
			await saveItem(store, memory, {
				conversationId: "main",
				messageId: run.inputMessageId,
				quote: "辛いものが好き",
				kind: "preference",
				semanticKey: "food.spicy",
				text: "辛いものが好き",
			});
		},
		/** The steward's verdict "drop": these exchanges leave the prompt (they stay recallable). */
		dropFromPrompt: (...inputMessageIds: string[]) =>
			store.write((db) => {
				for (const id of inputMessageIds) {
					memory.setDispositionInTransaction(db, id, "drop");
					memory.markExchangeStepInTransaction(db, id, "curated", "done");
					memory.markExchangeStepInTransaction(db, id, "disposed", "done");
				}
			}),
	};
	open.push(async () => {
		await queue.close(100).catch(() => {});
		await store.close().catch(() => {});
		rmSync(dir, { recursive: true, force: true });
	});
	return harness;
}
type Harness = Awaited<ReturnType<typeof setup>>;

/** Thirteen finished exchanges; the steward dropped the 1st and 2nd from the prompt, the 8th is still sent verbatim. */
async function history(h: Harness, firstIndex = 1) {
	const runs = [];
	for (let i = firstIndex; i < firstIndex + 13; i++)
		runs.push(await h.ask(`${i === 8 ? "京都の近況" : `話題${i}`}を話します`));
	await h.dropFromPrompt(runs[0]!.inputMessageId, runs[1]!.inputMessageId);
	return runs;
}
const messageText = (h: Harness, id: string) =>
	h.conversation.get("main").messages.find((m) => m.id === id)!.text;
const recallOf = (messages: Message[]) =>
	messages.find(
		(m) => m.role === "system" && m.content.includes(RECALL_HEADER),
	);

for (const withState of [false, true]) {
	test(`an exchange the prompt does not show is recalled by this turn's vector, before the policy and the input (${withState ? "with" : "without"} stored memory)`, async () => {
		const h = await setup();
		if (withState) await h.seedState();
		const runs = await history(h);
		const text = (i: number) => messageText(h, runs[i]!.inputMessageId);
		// Runs 0 and 1 are not in the prompt; 7 is. All three are about Kyoto.
		await h.putVector(runs[0]!.inputMessageId, KYOTO);
		await h.putVector(runs[1]!.inputMessageId, KYOTO);
		await h.putVector(runs[7]!.inputMessageId, KYOTO);
		await h.putVector(runs[3]!.inputMessageId, OTHER);
		const run = await h.ask("京都の話の続きを聞かせて");
		expect(run.status).toBe("completed");
		const messages = h.seen.at(-1)!;
		const recall = recallOf(messages)!;
		expect(recall).toBeDefined();
		expect(recall.content).toContain(text(0));
		expect(recall.content).toContain(text(1));
		// What the prompt already shows is not repeated; neither is a topic that does not match.
		expect(recall.content).not.toContain(text(7));
		expect(recall.content).not.toContain(text(3));
		// Placed after the memory layers and the history, before the conversation policy and the input.
		const at = messages.indexOf(recall);
		const policy = messages.findIndex(
			(m) => m.content === conversationPolicy(false),
		);
		expect(policy).toBeGreaterThan(at);
		expect(messages.at(-1)).toEqual({
			role: "user",
			content: "京都の話の続きを聞かせて",
		});
		expect(at).toBeGreaterThan(
			messages.map((m) => m.role).lastIndexOf("assistant"),
		);
		expect(policy).toBeLessThan(messages.length - 1);
		// The adopted answer leaves a usage receipt.
		expect(h.memory.usage(run.id)).not.toBeNull();
	});
}

test("a vector of another space, no vector for the request, or memory off recalls nothing", async () => {
	const h = await setup();
	const runs = await history(h);
	await h.putVector(runs[0]!.inputMessageId, KYOTO, {
		...SPACE,
		revision: "2",
	});
	expect((await h.ask("京都の話")).status).toBe("completed");
	expect(recallOf(h.seen.at(-1)!)).toBeUndefined();
	// Same space now; the provider is unavailable for the request.
	await h.putVector(runs[0]!.inputMessageId, KYOTO);
	h.query.current = undefined;
	expect((await h.ask("京都の話")).status).toBe("completed");
	expect(recallOf(h.seen.at(-1)!)).toBeUndefined();
	// With the vector available it is found; switched off, it is not.
	h.query.current = { space: SPACE, vector: KYOTO };
	await h.ask("京都の話");
	expect(recallOf(h.seen.at(-1)!)).toBeDefined();
	await h.memory.setEnabled(false);
	await h.ask("京都の話");
	expect(recallOf(h.seen.at(-1)!)).toBeUndefined();
});

test("a recalled message whose text changes during the generation expires the run", async () => {
	const h = await setup();
	const runs = await history(h);
	await h.putVector(runs[0]!.inputMessageId, KYOTO);
	h.during.current = () => h.edit(runs[0]!.inputMessageId, "書き換えた");
	const run = await h.ask("京都の話");
	expect(run.status).toBe("failed");
	expect(run.error).toBe("memory_stale");
	expect(run.answerMessageId).toBeNull();
	expect(h.memory.usage(run.id)).toBeNull();
	// Unchanged, the same request is adopted.
	h.during.current = undefined;
	await h.putVector(runs[1]!.inputMessageId, KYOTO);
	expect((await h.ask("京都の話")).status).toBe("completed");
});

test("the prefetch and this turn's recall never carry the same message, and a changed prefetch message expires the run", async () => {
	const h = await setup();
	const runs = await history(h);
	await h.putVector(runs[0]!.inputMessageId, KYOTO);
	await h.putVector(runs[1]!.inputMessageId, KYOTO);
	// The memory agent prefetched the first exchange for this turn.
	const prefetched = [runs[0]!.inputMessageId, runs[0]!.answerMessageId!];
	const prefetchText = `<${RECALL_HEADER}>\n[{"user":"${messageText(h, prefetched[0]!)}"}]\n</${RECALL_HEADER}>`;
	await h.store.write((db) =>
		h.memory.windows.rebuildInTransaction(db, "main", {
			refreshLongTerm: false,
			prefetch: {
				text: prefetchText,
				pins: prefetched.map((messageId) => ({
					messageId,
					digest: sha256Hex(messageText(h, messageId)),
				})),
				bytes: Buffer.byteLength(prefetchText),
			},
		}),
	);
	const run = await h.ask("京都の話");
	expect(run.status).toBe("completed");
	const messages = h.seen.at(-1)!;
	const blocks = messages.filter(
		(m) => m.role === "system" && m.content.includes(RECALL_HEADER),
	);
	expect(blocks).toHaveLength(2);
	const [first, second] = blocks as [Message, Message];
	// The prefetch comes first (it is the window's), this turn's recall after it.
	expect(first.content).toBe(prefetchText);
	expect(second.content).toContain(messageText(h, runs[1]!.inputMessageId));
	expect(second.content).not.toContain(messageText(h, prefetched[0]!));
	expect(messages.indexOf(first)).toBeLessThan(messages.indexOf(second));
	// A prefetched message that changes while the answer is generated expires the run.
	h.during.current = () => h.edit(prefetched[0]!, "書き換えた");
	const stale = await h.ask("京都の話");
	expect(stale.status).toBe("failed");
	expect(stale.error).toBe("memory_stale");
});

test("the recall has no ordinal boundary: runs the size limit cut from the prompt are searched too", async () => {
	const h = await setup();
	const runs = [];
	// Twelve exchanges of ~18 KB each (cut to 12 KB in the prompt): the history limit (48 KiB) keeps only the newest few.
	for (let i = 0; i < 12; i++)
		runs.push(await h.ask(`話${i}は${"京都".repeat(3000)}`));
	const texts = runs.map((r) => messageText(h, r.inputMessageId));
	for (const r of runs) await h.putVector(r.inputMessageId, KYOTO);
	const run = await h.ask("京都の話を続けて");
	expect(run.status).toBe("completed");
	const messages = h.seen.at(-1)!;
	const sent = (text: string) =>
		messages.some((m) => m.role === "user" && m.content === text);
	const recall = recallOf(messages)!;
	expect(recall).toBeDefined();
	const recalled = texts.filter((_, i) => recall.content.includes(`話${i}は`));
	expect(recalled.length).toBeGreaterThan(0);
	// Nothing recalled is also sent verbatim, and at least one of them is among the ten newest runs.
	for (const text of recalled) expect(sent(text)).toBe(false);
	expect(recalled.some((text) => texts.slice(-10).includes(text))).toBe(true);
});

test("a prefetch standing on exchanges already shown is left out for the turn, and its messages are not checked", async () => {
	const h = await setup();
	const runs = await history(h);
	const inside = [runs[7]!.inputMessageId, runs[7]!.answerMessageId!];
	const text = `<${RECALL_HEADER}>\n["重複"]\n</${RECALL_HEADER}>`;
	await h.store.write((db) =>
		h.memory.windows.rebuildInTransaction(db, "main", {
			refreshLongTerm: false,
			prefetch: {
				text,
				pins: inside.map((messageId) => ({
					messageId,
					digest: sha256Hex(messageText(h, messageId)),
				})),
				bytes: Buffer.byteLength(text),
			},
		}),
	);
	h.query.current = undefined;
	h.during.current = () => h.edit(inside[0]!, "書き換えた");
	const run = await h.ask("京都の話");
	// Not sent, and an edit of the message it stood on does not expire the run.
	expect(h.seen.at(-1)!.some((m) => m.content === text)).toBe(false);
	expect(run.status).toBe("completed");
});

test("quiet window: no recall means no check, no receipt and a streamed body; a recall means a check, a receipt and a held body", async () => {
	const h = await setup({ stream: true });
	const runs = await history(h);
	const progress = async (text: string) => {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text,
		});
		const streamed: string[] = [];
		const stop = h.dialogue.subscribeProgress(run.id, (p) =>
			streamed.push(p.text),
		);
		await until(() => h.dialogue.get(run.id)?.status === "completed");
		stop();
		return {
			run: h.dialogue.get(run.id)!,
			streamed: streamed.filter((t) => t !== "" && t !== "了解です"),
		};
	};
	// Nothing to recall: even an edit of an old message during the answer cannot expire it.
	h.query.current = undefined;
	const plain = await progress("天気は？");
	expect(plain.streamed.length).toBeGreaterThan(0);
	expect(h.memory.usage(plain.run.id)).toBeNull();
	// With a recalled exchange the body is held until adoption and the run leaves a receipt.
	await h.putVector(runs[0]!.inputMessageId, KYOTO);
	h.query.current = { space: SPACE, vector: KYOTO };
	const recalled = await progress("京都の話");
	expect(recallOf(h.seen.at(-1)!)).toBeDefined();
	expect(recalled.streamed).toEqual([]);
	expect(h.memory.usage(recalled.run.id)).not.toBeNull();
});

test("a quiet window does not adopt an answer whose shown history was forgotten meanwhile", async () => {
	const h = await setup();
	const runs = await history(h);
	h.query.current = undefined;
	const block = (messageId: string, reason: "forgotten" | "scheduled_prompt") =>
		h.store.write((db) =>
			db
				.query(
					"INSERT INTO memory_message_block (message_id, conversation_id, reason, forget_id, created_at) VALUES (?,?,?,?,?)",
				)
				.run(messageId, "main", reason, null, "2026-10-13T12:00:00.000Z"),
		);
	// A shown message blocked before the prompt was built (a scheduled prompt) does not expire the run.
	await block(runs[3]!.inputMessageId, "scheduled_prompt");
	const known = await h.ask("天気は？");
	expect(known.status).toBe("completed");
	// One forgotten while the answer is generated does, although the window adds nothing to the prompt.
	h.during.current = async () => {
		await block(runs[4]!.inputMessageId, "forgotten");
	};
	const stale = await h.ask("天気は？");
	expect(recallOf(h.seen.at(-1)!)).toBeUndefined();
	expect(stale.status).toBe("failed");
	expect(stale.error).toBe("memory_stale");
	expect(h.memory.usage(stale.id)).toBeNull();
});

test("a toolchain operation is checked against the recalled messages even when the window is quiet", async () => {
	const h = await setup({ operation: true });
	const runs = await history(h);
	await h.putVector(runs[0]!.inputMessageId, KYOTO);
	h.during.current = () => h.edit(runs[0]!.inputMessageId, "書き換えた");
	const stale = await h.ask("京都の天気を調べて");
	expect(recallOf(h.seen.at(-1)!)).toBeDefined();
	expect(stale.status).toBe("failed");
	expect(stale.error).toBe("memory_stale");
	// Without a recall the same edit is not this feature's concern (the stub then refuses the toolchain).
	h.query.current = undefined;
	h.during.current = () => h.edit(runs[1]!.inputMessageId, "これも書き換えた");
	const plain = await h.ask("京都の天気を調べて");
	expect(recallOf(h.seen.at(-1)!)).toBeUndefined();
	expect(plain.error).toBe("toolchain_unavailable");
});
