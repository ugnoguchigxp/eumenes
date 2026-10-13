import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import {
	migration as conversationMigration,
	avatarMotionMigration,
	answerDeliveryMigration,
	createConversationService,
} from "../../conversation";
import type { WindowSnapshot } from "../../memory";
import type { Run } from "../contracts";
import {
	agentLinkMigration,
	migration,
	queueLinkMigration,
	worldStateMigration,
} from "..";
import { insert } from "../repository";
import {
	HISTORY_MAX_BYTES,
	TURN_WINDOW,
	compileContext,
} from "../service/context-compiler";

const dirs: string[] = [];
const stores: SqliteStore[] = [];
afterEach(async () => {
	for (const s of stores.splice(0)) await s.close().catch(() => {});
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A conversation of `count` completed exchanges whose answers are `answerBytes` long, plus the current run. */
async function setup(count: number, answerBytes: number) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-compiler-"));
	dirs.push(dir);
	const store = openStore(join(dir, "db.sqlite3"), [
		conversationMigration,
		avatarMotionMigration,
		answerDeliveryMigration,
		migration,
		queueLinkMigration,
		agentLinkMigration,
		worldStateMigration,
	]);
	stores.push(store);
	const conversation = createConversationService(store);
	const at = "2026-10-13T00:00:00.000Z";
	const runs: Run[] = [];
	await store.write((db) => {
		for (let i = 1; i <= count + 1; i++) {
			const current = i === count + 1;
			conversation.appendInTransaction(db, {
				id: `u${i}`,
				conversationId: "main",
				role: "user",
				text: `質問${i}`,
				createdAt: at,
				runId: null,
			});
			if (!current)
				conversation.appendInTransaction(db, {
					id: `a${i}`,
					conversationId: "main",
					role: "assistant",
					text: `回答${i}:` + "a".repeat(answerBytes),
					createdAt: at,
					runId: `r${i}`,
				});
			const run: Run = {
				id: `r${i}`,
				agentTaskId: null,
				requestId: `req${i}`,
				conversationId: "main",
				utteranceId: null,
				status: current ? "running" : "completed",
				revision: 1,
				inputMessageId: `u${i}`,
				answerMessageId: current ? null : `a${i}`,
				error: null,
				jobId: null,
				deadlineAt: null,
				sourceKind: "manual",
				scheduleId: null,
				occurrenceId: null,
				worldUsed: false,
				worldBlocked: false,
				createdAt: at,
				updatedAt: at,
			};
			insert(db, run);
			runs.push(run);
		}
	});
	return { store, conversation, current: runs.at(-1)! };
}

const windowOf = (over: Partial<WindowSnapshot> = {}): WindowSnapshot => ({
	conversationId: "main",
	version: 1,
	buildId: "b",
	inputs: {
		immediateSeq: 0,
		stateChangeSeq: 0,
		continuityRevision: 0,
		tendencyRevision: 0,
		policyRevision: "1",
	},
	longTerm: {
		text: "L1本文",
		manifest: [],
		omitted: [],
		publishedOn: "2026-10-13",
		bytes: 5,
	},
	shortTerm: { text: "L2本文", bytes: 5, pendingAdditions: 0 },
	prefetch: { text: "", pins: [], bytes: 0 },
	notices: [],
	...over,
});

test("only the latest TURN_WINDOW exchanges are sent, in order, between the layers and the input", async () => {
	const h = await setup(TURN_WINDOW + 3, 10);
	const { messages, references, tail } = h.store.read((db) =>
		compileContext(db, h.current, h.conversation, undefined, windowOf()),
	);
	expect(references).toEqual(["L1本文", "L2本文"]);
	expect(tail).toEqual([]);
	expect(messages.slice(1, 3).map((m) => m.content)).toEqual([
		"L1本文",
		"L2本文",
	]);
	const history = messages.slice(3, -1);
	expect(history).toHaveLength(TURN_WINDOW * 2);
	expect(history[0]!.content).toBe("質問4");
	expect(messages.at(-1)).toEqual({
		role: "user",
		content: `質問${TURN_WINDOW + 4}`,
	});
});

test("over HISTORY_MAX_BYTES the oldest exchanges go first and the last two always stay", async () => {
	const big = Math.floor(HISTORY_MAX_BYTES / 3);
	const h = await setup(6, big);
	const { messages } = h.store.read((db) =>
		compileContext(db, h.current, h.conversation, undefined, null),
	);
	const history = messages.slice(1, -1);
	const bytes = history.reduce((n, m) => n + Buffer.byteLength(m.content), 0);
	expect(bytes).toBeLessThanOrEqual(HISTORY_MAX_BYTES);
	expect(history.length).toBeLessThan(12);
	// Whole exchanges only, newest kept.
	expect(history.length % 2).toBe(0);
	expect(history.at(-2)!.content).toBe("質問6");
	expect(history.some((m) => m.content === "質問1")).toBe(false);

	// Larger than the cap even for two exchanges: exactly the last two remain.
	const huge = await setup(5, HISTORY_MAX_BYTES);
	const kept = huge.store
		.read((db) =>
			compileContext(db, huge.current, huge.conversation, undefined, null),
		)
		.messages.slice(1, -1);
	expect(kept.map((m) => m.content.slice(0, 3))).toEqual([
		"質問4",
		"回答4",
		"質問5",
		"回答5",
	]);
});

test("notices and prefetched text are the tail, notices first; no window means no layers", async () => {
	const h = await setup(1, 10);
	const compiled = h.store.read((db) =>
		compileContext(
			db,
			h.current,
			h.conversation,
			undefined,
			windowOf({
				notices: [
					{ id: "n1", text: "一件目" },
					{ id: "n2", text: "二件目" },
				],
				prefetch: { text: "昔のやり取り", pins: [], bytes: 9 },
			}),
		),
	);
	expect(compiled.tail).toHaveLength(2);
	expect(compiled.tail[0]!.content).toContain("記憶の担当からの連絡です");
	expect(compiled.tail[0]!.content).toContain("- 一件目\n- 二件目");
	expect(compiled.tail[1]!.content).toBe("昔のやり取り");
	const none = h.store.read((db) =>
		compileContext(db, h.current, h.conversation, undefined, null),
	);
	expect(none.references).toEqual([]);
	expect(none.tail).toEqual([]);
	expect(none.messages.map((m) => m.role)).toEqual([
		"system",
		"user",
		"assistant",
		"user",
	]);
});
