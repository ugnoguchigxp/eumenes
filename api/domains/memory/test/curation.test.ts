import { afterEach, expect, test } from "bun:test";
import { configureLogging } from "../../../infrastructure/logger";
import type { CurationItem } from "../contracts";
import { setupMemory, type MemoryHarness } from "./memory.fixture";

const open: MemoryHarness[] = [];
afterEach(async () => {
	configureLogging({ level: "silent" });
	for (const h of open.splice(0)) await h.close();
});
async function setup() {
	const h = await setupMemory();
	open.push(h);
	return h;
}
const remember = (
	messageId: string,
	over: Partial<Extract<CurationItem, { op: "remember" }>> = {},
): CurationItem => ({
	op: "remember",
	kind: "preference",
	key: "food.spicy",
	text: "辛いものが好き",
	messageId,
	quote: "辛いものが好き",
	...over,
});
const only = <T>(list: T[]): T => {
	if (list.length !== 1) throw new Error("expected one");
	return list[0] as T;
};
const itemOf = (h: MemoryHarness, id: string | null) => {
	const found = h.memory.list(true).find((entry) => entry.id === id);
	if (!found) throw new Error("item_missing");
	return found;
};

test("a quote that is found becomes the evidence range; the result and provenance say it matched", async () => {
	const h = await setup();
	const id = await h.say("user", "私は辛いものが好きです。毎朝走っています。");
	const result = only(await h.curate([remember(id)]));
	if (result.status !== "applied") throw new Error("rejected");
	expect(result).toMatchObject({ quoteMatched: true, changed: true });
	expect(itemOf(h, result.id).evidence).toEqual([
		{ messageId: id, quote: "辛いものが好き" },
	]);
	// Spaces, punctuation and width forms are forgiven; the range is the original slice.
	const text = await h.say("user", "毎朝 5時に起きて、走って いる。");
	const second = only(
		await h.curate([
			remember(text, {
				key: "habit.run",
				kind: "habit",
				text: "毎朝5時に起きて走っている",
				quote: "毎朝5時に起きて走って",
			}),
		]),
	);
	if (second.status !== "applied") throw new Error("rejected");
	expect(second.quoteMatched).toBe(true);
	expect(itemOf(h, second.id).evidence[0]?.quote).toBe(
		"毎朝 5時に起きて、走って",
	);
});

test("a quote that is not found falls back to the whole user message and says so", async () => {
	const h = await setup();
	const id = await h.say("user", "私は辛いものが好きです");
	for (const quote of ["全然ちがう文", null, ""]) {
		const result = only(
			await h.curate([
				remember(id, { key: `k.${String(quote).length}`, quote }),
			]),
		);
		if (result.status !== "applied") throw new Error("rejected");
		expect(result.quoteMatched).toBe(false);
		expect(itemOf(h, result.id).evidence).toEqual([
			{ messageId: id, quote: "私は辛いものが好きです" },
		]);
	}
});

test("a long message keeps the library's 1024-byte evidence limit: the matched quote's start or the window that shares the most words", async () => {
	const h = await setup();
	const filler = "あ".repeat(900);
	const tail = "そして私は辛いものが好きでコーヒーも好きです";
	const id = await h.say("user", `${filler}${tail}`);
	const bytes = (text: string) => Buffer.byteLength(text, "utf8");
	// Not found: the window around the words the fact shares, not the filler at the start.
	const unmatched = only(
		await h.curate([remember(id, { quote: "存在しない" })]),
	);
	if (unmatched.status !== "applied") throw new Error("rejected");
	const window = itemOf(h, unmatched.id).evidence[0]!.quote!;
	expect(bytes(window)).toBeLessThanOrEqual(1024);
	expect(window).toContain("辛いものが好き");
	// Found but longer than the limit: its beginning.
	const long = "い".repeat(1500);
	const longId = await h.say("user", `前置き${long}`);
	const matched = only(
		await h.curate([
			remember(longId, { key: "long.one", text: "いい", quote: long }),
		]),
	);
	if (matched.status !== "applied") throw new Error("rejected");
	const kept = itemOf(h, matched.id).evidence[0]!.quote!;
	expect(bytes(kept)).toBeLessThanOrEqual(1024);
	expect(long.startsWith(kept)).toBe(true);
});

test("the assistant's words, another conversation's message and a missing message are not evidence", async () => {
	const h = await setup();
	const assistant = await h.say("assistant", "辛いものがお好きなんですね");
	const other = await h.say("user", "辛いものが好きです", "c2");
	const results = await h.curate([
		remember(assistant),
		remember(other, { key: "other" }),
		remember("nope", { key: "missing" }),
	]);
	expect(results).toEqual([
		{ status: "rejected", op: "remember", reason: "invalid_source" },
		{ status: "rejected", op: "remember", reason: "invalid_source" },
		{ status: "rejected", op: "remember", reason: "invalid_source" },
	]);
	expect(h.memory.list(true)).toEqual([]);
});

test("a blocked message is never evidence, even for an explicit request", async () => {
	const h = await setup();
	const id = await h.say("user", "辛いものが好きです");
	await h.store.write((db) =>
		h.memory.blockMessagesInTransaction(db, {
			conversationId: "c1",
			messageIds: [id],
			reason: "scheduled_prompt",
		}),
	);
	const results = await h.curate([
		remember(id),
		remember(id, { explicit: true, key: "k2" }),
		{ op: "note_add", kind: "memo", text: "メモ", messageIds: [id] },
	]);
	expect(
		results.map((r) => (r.status === "rejected" ? r.reason : "applied")),
	).toEqual(["blocked_source", "blocked_source", "blocked_source"]);
});

test("the same key replaces the active item (no ACTIVE_EXISTS); the same value is not written again", async () => {
	const h = await setup();
	const a = await h.say("user", "辛いものが好きです");
	const b = await h.say("user", "最近は辛いものが苦手です");
	const first = only(await h.curate([remember(a)]));
	if (first.status !== "applied") throw new Error("rejected");
	const replaced = only(
		await h.curate([
			remember(b, { text: "辛いものが苦手", quote: "辛いものが苦手" }),
		]),
	);
	if (replaced.status !== "applied") throw new Error("rejected");
	expect(replaced.id).not.toBe(first.id);
	expect(itemOf(h, first.id).status).toBe("superseded");
	expect(itemOf(h, replaced.id).status).toBe("active");
	// The value stays: nothing new, no new version.
	const again = only(
		await h.curate([
			remember(b, { text: "辛いものが苦手", quote: "辛いものが苦手" }),
		]),
	);
	expect(again).toMatchObject({
		status: "applied",
		changed: false,
		id: replaced.id,
		reconfirmed: false,
	});
	expect(h.memory.list(true)).toHaveLength(2);
});

test("an explicit request always writes a new, user-confirmed version, even for the same value", async () => {
	const h = await setup();
	const a = await h.say("user", "辛いものが好きです");
	const b = await h.say("user", "辛いものが好きなので覚えておいて");
	const inferred = only(await h.curate([remember(a)]));
	if (inferred.status !== "applied") throw new Error("rejected");
	expect(itemOf(h, inferred.id).origin).toBe("agent_inferred");
	expect(itemOf(h, inferred.id).capturedBy).toBe("agent");
	const confirmed = only(await h.curate([remember(b, { explicit: true })]));
	if (confirmed.status !== "applied") throw new Error("rejected");
	expect(confirmed).toMatchObject({ changed: true, reconfirmed: true });
	expect(confirmed.id).not.toBe(inferred.id);
	expect(itemOf(h, confirmed.id)).toMatchObject({
		origin: "user_confirmed",
		status: "active",
		capturedBy: "request",
		evidence: [{ messageId: b }],
	});
	// The old version stays as history and no longer counts.
	expect(itemOf(h, inferred.id).status).toBe("inactive");
	// And again: still a new version.
	const third = only(await h.curate([remember(b, { explicit: true })]));
	if (third.status !== "applied") throw new Error("rejected");
	expect(third).toMatchObject({ changed: true, reconfirmed: true });
	expect(third.id).not.toBe(confirmed.id);
	expect(h.memory.list(false).map((i) => i.id)).toEqual([third.id!]);
});

test("an element with an invalid key, text, date or kind is rejected alone; the others are written", async () => {
	const h = await setup();
	const id = await h.say("user", "辛いものが好きです。毎朝走っています");
	const results = await h.curate([
		remember(id, { key: "辛い" }),
		remember(id, { key: "" }),
		remember(id, { key: "ok.one" }),
		remember(id, { key: "Food.Two", text: "二つ目", quote: "毎朝走って" }),
		remember(id, { key: "three", text: "  " }),
		remember(id, { key: "four", validFrom: "2026-13-99x" }),
		remember(id, { key: "five", kind: "other_person_note" as never }),
	]);
	expect(
		results.map((r) => (r.status === "rejected" ? r.reason : "applied")),
	).toEqual([
		"invalid_key",
		"invalid_key",
		"applied",
		"applied",
		"invalid_input",
		"invalid_validity",
		"invalid_input",
	]);
	// The key is stored normalized.
	expect(
		h.memory
			.list(true)
			.map((i) => i.semanticKey)
			.sort(),
	).toEqual(["food.two", "ok.one"]);
});

test("validity bounds are stored with their precision", async () => {
	const h = await setup();
	const id = await h.say("user", "9月からZedを使っています");
	const result = only(
		await h.curate([
			remember(id, {
				key: "editor",
				kind: "habit",
				text: "Zedを使っている",
				quote: "Zedを使って",
				validFrom: "2026-09",
				validUntil: null,
			}),
		]),
	);
	if (result.status !== "applied") throw new Error("rejected");
	expect(itemOf(h, result.id).validity).toEqual({ from: "2026-09" });
});

test("update rewrites an item at the revision the model saw; a changed item is item_changed", async () => {
	const h = await setup();
	const a = await h.say("user", "辛いものが好きです");
	const b = await h.say("user", "最近は辛いものも食べられます");
	const first = only(await h.curate([remember(a)]));
	if (first.status !== "applied") throw new Error("rejected");
	const stale = only(
		await h.curate([
			{
				op: "update",
				itemId: first.id!,
				revision: first.revision! + 5,
				text: "x",
				messageId: b,
			},
		]),
	);
	expect(stale).toEqual({
		status: "rejected",
		op: "update",
		reason: "item_changed",
	});
	const updated = only(
		await h.curate([
			{
				op: "update",
				itemId: first.id!,
				revision: first.revision!,
				text: "辛いものも食べられる",
				messageId: b,
				quote: "辛いものも食べられます",
			},
		]),
	);
	if (updated.status !== "applied") throw new Error("rejected");
	expect(itemOf(h, updated.id)).toMatchObject({
		text: "辛いものも食べられる",
		semanticKey: "food.spicy",
		origin: "agent_inferred",
	});
	expect(itemOf(h, first.id).status).toBe("superseded");
	const unknown = only(
		await h.curate([
			{
				op: "update",
				itemId: `state:${"a".repeat(64)}`,
				revision: 1,
				text: "x",
				messageId: b,
			},
		]),
	);
	expect(unknown).toMatchObject({ status: "rejected", reason: "unknown_item" });
});

test("stop makes the item inactive and expires runs in flight; a stale revision is refused", async () => {
	const h = await setup();
	const id = await h.say("user", "辛いものが好きです");
	const saved = only(await h.curate([remember(id)]));
	if (saved.status !== "applied") throw new Error("rejected");
	await h.window();
	const seq = () =>
		h.store.read(
			(db) =>
				(
					db
						.query(
							"SELECT COALESCE(MAX(seq),0) AS s FROM memory_immediate_change",
						)
						.get() as { s: number }
				).s,
		);
	const before = seq();
	const refused = only(
		await h.curate([{ op: "stop", itemId: saved.id!, revision: 99 }]),
	);
	expect(refused).toMatchObject({ status: "rejected", reason: "item_changed" });
	expect(seq()).toBe(before);
	const stopped = only(
		await h.curate([
			{ op: "stop", itemId: saved.id!, revision: saved.revision! },
		]),
	);
	expect(stopped).toMatchObject({ status: "applied", op: "stop" });
	expect(itemOf(h, saved.id).status).toBe("inactive");
	expect(seq()).toBe(before + 1);
});

test("merge carries the union of the evidence, replaces the key it keeps and stops the others", async () => {
	const h = await setup();
	const a = await h.say("user", "コーヒーが好きです");
	const b = await h.say("user", "紅茶も好きです");
	const c = await h.say("user", "毎朝走っています");
	const first = only(
		await h.curate([
			remember(a, {
				key: "drink.coffee",
				text: "コーヒーが好き",
				quote: "コーヒーが好き",
			}),
		]),
	);
	const second = only(
		await h.curate([
			remember(b, {
				key: "drink.tea",
				text: "紅茶が好き",
				quote: "紅茶も好き",
			}),
		]),
	);
	if (first.status !== "applied" || second.status !== "applied")
		throw new Error("rejected");
	void c;
	const merged = only(
		await h.curate([
			{
				op: "merge",
				sources: [
					{ itemId: first.id!, revision: first.revision! },
					{ itemId: second.id!, revision: second.revision! },
				],
				key: "drink.favorite",
				text: "コーヒーと紅茶が好き",
			},
		]),
	);
	if (merged.status !== "applied") throw new Error(JSON.stringify(merged));
	const item = itemOf(h, merged.id);
	expect(item).toMatchObject({
		semanticKey: "drink.favorite",
		status: "active",
	});
	expect(item.evidence.map((e) => e.messageId).sort()).toEqual([a, b].sort());
	expect(merged.stoppedIds.sort()).toEqual([first.id!, second.id!].sort());
	expect(itemOf(h, first.id).status).toBe("inactive");
	expect(itemOf(h, second.id).status).toBe("inactive");
	// Without a key, the newest source's key is kept, which replaces that source instead of stopping it.
	const third = only(
		await h.curate([
			remember(c, {
				key: "habit.run",
				kind: "habit",
				text: "毎朝走る",
				quote: "毎朝走って",
			}),
		]),
	);
	if (third.status !== "applied") throw new Error("rejected");
	const again = only(
		await h.curate([
			{
				op: "merge",
				sources: [
					{ itemId: merged.id!, revision: merged.revision! },
					{ itemId: third.id!, revision: third.revision! },
				],
				text: "走ることと飲み物が好き",
			},
		]),
	);
	// Different kinds cannot be merged.
	expect(again).toMatchObject({ status: "rejected", reason: "invalid_input" });
});

test("merge drops blocked and tombstoned evidence and is rejected when none is left", async () => {
	const h = await setup();
	const a = await h.say("user", "コーヒーが好きです");
	const b = await h.say("user", "紅茶も好きです");
	const first = only(
		await h.curate([
			remember(a, {
				key: "drink.coffee",
				text: "コーヒーが好き",
				quote: "コーヒーが好き",
			}),
		]),
	);
	const second = only(
		await h.curate([
			remember(b, {
				key: "drink.tea",
				text: "紅茶が好き",
				quote: "紅茶も好き",
			}),
		]),
	);
	if (first.status !== "applied" || second.status !== "applied")
		throw new Error("rejected");
	const merge = (key: string): CurationItem => ({
		op: "merge",
		sources: [
			{ itemId: first.id!, revision: first.revision! },
			{ itemId: second.id!, revision: second.revision! },
		],
		key,
		text: "飲み物が好き",
	});
	// One source message is blocked: the merged item stands on the other.
	await h.store.write((db) =>
		h.memory.blockMessagesInTransaction(db, {
			conversationId: "c1",
			messageIds: [a],
			reason: "scheduled_prompt",
		}),
	);
	const kept = only(await h.curate([merge("drink.any")]));
	if (kept.status !== "applied") throw new Error(JSON.stringify(kept));
	expect(itemOf(h, kept.id).evidence.map((e) => e.messageId)).toEqual([b]);
	// Every remaining source is gone too: no evidence left.
	const x = await h.say("user", "ラテが好きです");
	const y = await h.say("user", "お茶が好きです");
	const latte = only(
		await h.curate([
			remember(x, { key: "d.latte", text: "ラテが好き", quote: "ラテが好き" }),
		]),
	);
	const tea = only(
		await h.curate([
			remember(y, { key: "d.tea", text: "お茶が好き", quote: "お茶が好き" }),
		]),
	);
	if (latte.status !== "applied" || tea.status !== "applied")
		throw new Error("rejected");
	await h.store.write((db) => {
		h.memory.blockMessagesInTransaction(db, {
			conversationId: "c1",
			messageIds: [x],
			reason: "scheduled_prompt",
		});
		// A tombstone of the other message as a source (as the library's own forget leaves it).
		db.query(
			"INSERT INTO memory_tombstone (target_type, target_id, principal, scope_key, forget_id, seq, journal_seq) VALUES ('source', ?, 'owner', 'profile:owner', 'f', 1, 1)",
		).run(JSON.stringify(["conversation", "message", y, "text"]));
	});
	const none = only(
		await h.curate([
			{
				op: "merge",
				sources: [
					{ itemId: latte.id!, revision: latte.revision! },
					{ itemId: tea.id!, revision: tea.revision! },
				],
				key: "d.all",
				text: "飲み物が好き",
			},
		]),
	);
	expect(none).toEqual({
		status: "rejected",
		op: "merge",
		reason: "no_evidence",
	});
	expect(itemOf(h, latte.id).status).toBe("active");
	expect(itemOf(h, tea.id).status).toBe("active");
});

test("notes: add, update and close in the conversation; the source must be a usable message", async () => {
	const h = await setup();
	const id = await h.say("user", "予算は3万円以内です");
	const added = only(
		await h.curate([
			{
				op: "note_add",
				kind: "decision",
				text: "予算は3万円以内",
				messageIds: [id],
			},
		]),
	);
	if (added.status !== "applied") throw new Error("rejected");
	expect(h.continuity.list("c1")[0]).toMatchObject({
		id: added.id,
		origin: "agent",
		sourceMessageIds: [id],
	});
	const updated = only(
		await h.curate([
			{
				op: "note_update",
				noteId: added.id!,
				revision: added.revision!,
				text: "予算は2万円以内",
			},
		]),
	);
	if (updated.status !== "applied") throw new Error("rejected");
	expect(
		only(
			await h.curate([
				{ op: "note_update", noteId: added.id!, revision: 1, text: "x" },
			]),
		),
	).toMatchObject({ status: "rejected", reason: "item_changed" });
	expect(
		only(
			await h.curate([
				{
					op: "note_close",
					noteId: added.id!,
					revision: updated.revision!,
					status: "resolved",
				},
			]),
		),
	).toMatchObject({ status: "applied" });
	expect(h.continuity.list("c1", true)[0]?.status).toBe("resolved");
	expect(
		only(
			await h.curate([
				{ op: "note_close", noteId: "ghost", revision: 1, status: "resolved" },
			]),
		),
	).toMatchObject({ status: "rejected", reason: "unknown_item" });
	// Another conversation's message, and a note over the limit.
	const foreign = await h.say("user", "別の話", "c2");
	expect(
		only(
			await h.curate([
				{ op: "note_add", kind: "memo", text: "x", messageIds: [foreign] },
			]),
		),
	).toMatchObject({ status: "rejected", reason: "invalid_source" });
	let limited = 0;
	for (let i = 0; i < 40; i++) {
		const r = only(
			await h.curate([
				{ op: "note_add", kind: "memo", text: `m${i}`, messageIds: [id] },
			]),
		);
		if (r.status === "rejected" && r.reason === "limit_reached") limited++;
	}
	expect(limited).toBeGreaterThan(0);
});

test("tendencies: add, update and retire with live evidence of two distinct items", async () => {
	const h = await setup();
	const a = await h.seed("コーヒーが好き", "drink.coffee");
	const b = await h.seed("毎朝走る", "run", "毎朝走る", "habit");
	const ev = [
		{ namespace: "state" as const, id: a.id },
		{ namespace: "state" as const, id: b.id },
	];
	expect(
		only(
			await h.curate([
				{ op: "tendency_add", text: "朝型", evidence: [ev[0]!] },
			]),
		),
	).toMatchObject({ status: "rejected", reason: "invalid_input" });
	expect(
		only(
			await h.curate([
				{ op: "tendency_add", text: "朝型", evidence: [ev[0]!, ev[0]!] },
			]),
		),
	).toMatchObject({ status: "rejected", reason: "invalid_input" });
	const added = only(
		await h.curate([{ op: "tendency_add", text: "朝型", evidence: ev }]),
	);
	if (added.status !== "applied") throw new Error("rejected");
	const updated = only(
		await h.curate([
			{
				op: "tendency_update",
				tendencyId: added.id!,
				revision: 1,
				text: "早起き",
				evidence: ev,
			},
		]),
	);
	expect(updated).toMatchObject({ status: "applied", revision: 2 });
	expect(
		only(
			await h.curate([
				{
					op: "tendency_update",
					tendencyId: added.id!,
					revision: 1,
					text: "x",
					evidence: ev,
				},
			]),
		),
	).toMatchObject({ status: "rejected", reason: "item_changed" });
	expect(
		only(
			await h.curate([
				{ op: "tendency_retire", tendencyId: added.id!, revision: 2 },
			]),
		),
	).toMatchObject({ status: "applied" });
	expect(h.memory.tendencies()).toEqual([]);
});

test("the active-item limit rejects a new key but not a replacement", async () => {
	const h = await setup();
	const id = await h.say("user", "辛いものが好きです");
	for (let i = 0; i < 100; i++) {
		const r = only(
			await h.curate([remember(id, { key: `k${i}`, text: `項目${i}` })]),
		);
		if (r.status !== "applied") throw new Error(`rejected at ${i}`);
	}
	expect(only(await h.curate([remember(id, { key: "over" })]))).toMatchObject({
		status: "rejected",
		reason: "limit_reached",
	});
	expect(
		only(await h.curate([remember(id, { key: "k0", text: "置き換え" })])),
	).toMatchObject({ status: "applied", changed: true });
}, 30_000);

test("curation is refused while memory is not usable", async () => {
	const h = await setup();
	const id = await h.say("user", "辛いものが好きです");
	const { writeFileSync } = await import("node:fs");
	const { join } = await import("node:path");
	writeFileSync(join(h.dir, "journal.jsonl"), "not json\n");
	expect((await h.memory.recover()).healthy).toBe(false);
	await expect(h.curate([remember(id)])).rejects.toThrow("memory_unavailable");
});

test("merge without a key keeps the newest source's key: that source is superseded, the others are stopped", async () => {
	const h = await setup();
	const a = await h.say("user", "コーヒーが好きです");
	const b = await h.say("user", "紅茶も好きです");
	const old = only(
		await h.curate([
			remember(a, {
				key: "drink.coffee",
				text: "コーヒーが好き",
				quote: "コーヒーが好き",
			}),
		]),
	);
	const newest = only(
		await h.curate([
			remember(b, {
				key: "drink.tea",
				text: "紅茶が好き",
				quote: "紅茶も好き",
			}),
		]),
	);
	if (old.status !== "applied" || newest.status !== "applied")
		throw new Error("rejected");
	const merged = only(
		await h.curate([
			{
				op: "merge",
				sources: [
					{ itemId: old.id!, revision: old.revision! },
					{ itemId: newest.id!, revision: newest.revision! },
				],
				text: "コーヒーと紅茶が好き",
			},
		]),
	);
	if (merged.status !== "applied") throw new Error(JSON.stringify(merged));
	expect(itemOf(h, merged.id).semanticKey).toBe("drink.tea");
	expect(itemOf(h, newest.id).status).toBe("superseded");
	expect(itemOf(h, old.id).status).toBe("inactive");
	expect(merged.stoppedIds).toEqual([old.id!]);
	expect(h.memory.list(false).map((i) => i.id)).toEqual([merged.id!]);
});
