import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { configureLogging } from "../../../infrastructure/logger";
import type {
	CorrectExplicitInput,
	RememberExplicitInput,
} from "../contracts/immediate";
import type { MemoryRecallInput } from "..";
import { settingsSchema } from "../contracts";
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
const write = <T>(h: MemoryHarness, run: (db: Database) => T) =>
	h.store.write((db) => run(db));

/** Saves one record the way "remember this" does: the user's message holds the words. */
async function remember(
	h: MemoryHarness,
	text: string,
	semanticKey: string,
	over: Partial<RememberExplicitInput> = {},
) {
	const messageId = await h.say("user", `覚えといて、${text}。`);
	return write(h, (db) =>
		h.memory.rememberExplicitInTransaction(db, {
			conversationId: "c1",
			sourceRunId: `run-${messageId}`,
			messageId,
			quote: text,
			kind: "personal_fact",
			semanticKey,
			subject: "self",
			text,
			polarity: "affirmed",
			...over,
		}),
	);
}
async function saved(
	h: MemoryHarness,
	text: string,
	semanticKey: string,
	over: Partial<RememberExplicitInput> = {},
) {
	const outcome = await remember(h, text, semanticKey, over);
	if (outcome.status !== "applied") throw new Error(JSON.stringify(outcome));
	return outcome;
}

const recall = (
	h: MemoryHarness,
	text: string,
	over: Partial<MemoryRecallInput> = {},
) =>
	h.store.read((db) =>
		h.memory.recallInTransaction(db, {
			text,
			limit: 10,
			shown: new Set(),
			omitShown: false,
			withPrevious: false,
			minScore: 0,
			audience: "tool",
			...over,
		}),
	);
const texts = (result: ReturnType<typeof recall>) =>
	result.items.map((item) => item.text);

test("there is no count limit: what the agent saves on its own, the steward's saves, seeds and a restored record are all kept past a hundred (seeds: seed-import.test.ts)", async () => {
	const h = await setup();
	const id = await h.say("user", "辛いものが好きです");
	const results = await h.curate(
		Array.from({ length: 101 }, (_, i) => ({
			op: "remember" as const,
			kind: "preference" as const,
			key: `k${i}`,
			text: `項目${i}番`,
			messageId: id,
		})),
	);
	expect(results.every((r) => r.status === "applied")).toBe(true);
	// The agent's own saving (not a request) is not refused for the count.
	expect(
		await remember(h, "毎日の散歩は川沿いのコース", "walk.course", {
			requested: false,
		}),
	).toMatchObject({ status: "applied" });
	// A stopped record comes back at any count.
	const [first] = h.memory.list(true);
	const stopped = await h.stop(first!.id, first!.revision);
	await h.memory.maintenance.apply({
		conversationId: "c1",
		active: true,
		refs: [{ kind: "state", id: stopped.id, revision: stopped.revision }],
	});
	expect(h.memory.list().length).toBe(102);
});

test("the pairs of the improvement design match: a one-character word, a sentence, a word under another key", async () => {
	const h = await setup();
	await saved(h, "猫の名前はミル", "pet.cat.name");
	await saved(h, "2025年に基本情報技術者試験に合格した", "cert.fe");
	await saved(
		h,
		"南川ユナイテッドを応援している。最近は試合をよく見ている。",
		"team.support",
		{ kind: "preference" },
	);
	await saved(h, "妹の名前は美咲", "sister.name");
	// "猫 名前": the one-character word 猫 used to match nothing.
	expect(texts(recall(h, "猫 名前"))[0]).toBe("猫の名前はミル");
	expect(texts(recall(h, "うちの猫の名前、覚えてる？"))[0]).toBe(
		"猫の名前はミル",
	);
	// A question written as a sentence reaches a record it shares only half the pairs with.
	expect(texts(recall(h, "今応援してるサッカーのチームってどこ？"))).toContain(
		"南川ユナイテッドを応援している。最近は試合をよく見ている。",
	);
	// The key and the attributes are part of what a record is found by.
	expect(texts(recall(h, "cert.fe"))[0]).toBe(
		"2025年に基本情報技術者試験に合格した",
	);
	// Only an empty query lists everything; one that reads as nothing (punctuation, a filler) matches nothing.
	expect(recall(h, "").matched).toBe(4);
	expect(recall(h, " ？ ").matched).toBe(0);
	expect(recall(h, "あ、え、").matched).toBe(0);
	// A lone hiragana is no word, a lone kanji is.
	expect(recall(h, "あ 猫").matched).toBe(1);
	expect(recall(h, "全く関係のない話").matched).toBe(0);
});

test("a record that shares most of the words comes before one that shares a single word", async () => {
	const h = await setup();
	await saved(h, "妹の名前は美咲", "sister.name");
	await saved(h, "妻の名前は恵子", "wife.name");
	await saved(h, "上司の名前は岡田", "boss.name");
	await saved(h, "猫の名前はミル", "cat.name");
	const result = recall(h, "上司の名前");
	expect(result.items[0]).toMatchObject({
		text: "上司の名前は岡田",
		direct: true,
	});
	expect(result.items[0]!.score).toBeGreaterThan(result.items[1]!.score);
	// The ties go to the newer record.
	expect(texts(result).slice(1)).toEqual([
		"猫の名前はミル",
		"妻の名前は恵子",
		"妹の名前は美咲",
	]);
	// minScore drops the weak matches; limit cuts the items, not the count.
	expect(texts(recall(h, "上司の名前", { minScore: 0.9 }))).toEqual([
		"上司の名前は岡田",
	]);
	expect(recall(h, "上司の名前", { limit: 1 })).toMatchObject({
		matched: 4,
		total: 4,
	});
	expect(recall(h, "上司の名前", { limit: 1 }).items).toHaveLength(1);
});

test("an empty query lists every record newest first, tendencies last, and reading changes nothing", async () => {
	const h = await setup();
	await saved(h, "妹の名前は美咲", "sister.name");
	await saved(h, "猫の名前はミル", "cat.name");
	const before = h.memory.list(true);
	const result = recall(h, "");
	expect(texts(result)).toEqual(["猫の名前はミル", "妹の名前は美咲"]);
	expect(result.items.every((item) => item.score === 0 && !item.direct)).toBe(
		true,
	);
	recall(h, "猫");
	expect(h.memory.list(true)).toEqual(before);
});

test("the host audience leaves suppressed records out, and marked records come only when a word of the query is in them", async () => {
	const h = await setup();
	const hidden = await saved(h, "通院している病院は駅前にある", "clinic", {
		sensitive: true,
	});
	await saved(h, "田島さんの趣味はカメラ", "tajima.hobby", {
		aboutOther: true,
	});
	const quiet = await saved(h, "京都出身で実家はお寺", "home.town");
	await write(h, (db) =>
		h.memory.suppressInTransaction(db, {
			conversationId: "c1",
			sourceRunId: "run-s",
			target: { itemId: quiet.itemId },
		}),
	);
	await saved(h, "毎朝コーヒーを飲む", "coffee");
	const host = (text: string) => recall(h, text, { audience: "host" });
	// Not named: neither the marked records nor the suppressed one.
	expect(texts(host(""))).toEqual(["毎朝コーヒーを飲む"]);
	expect(texts(host("最近どう？"))).toEqual([]);
	// Named: the marked record comes, with its marks; the suppressed one never does.
	expect(host("病院").items).toEqual([
		expect.objectContaining({
			id: hidden.itemId,
			sensitive: true,
			direct: true,
		}),
	]);
	expect(texts(host("田島さん、どうしてる？"))).toEqual([
		"田島さんの趣味はカメラ",
	]);
	expect(texts(host("京都"))).toEqual([]);
	// The tool reads everything, the suppressed record marked.
	expect(recall(h, "京都").items).toEqual([
		expect.objectContaining({ id: quiet.itemId, suppressed: true }),
	]);
	expect(recall(h, "").total).toBe(4);
});

test("a corrected record carries the old words and the day they stopped holding", async () => {
	const h = await setup();
	const old = await saved(h, "合言葉はさくら", "password");
	h.time.now = "2026-10-20T20:00:00.000Z";
	const messageId = await h.say("user", "合言葉はもみじに変えた");
	const correction: CorrectExplicitInput = {
		conversationId: "c1",
		sourceRunId: "run-c",
		messageId,
		quote: "合言葉はもみじ",
		text: "合言葉はもみじ",
		polarity: "affirmed",
		target: { itemId: old.itemId },
	};
	const outcome = await write(h, (db) =>
		h.memory.correctExplicitInTransaction(db, correction),
	);
	expect(outcome.status).toBe("applied");
	const withPrevious = recall(h, "合言葉", { withPrevious: true });
	expect(withPrevious.items).toHaveLength(1);
	expect(withPrevious.items[0]).toMatchObject({
		text: "合言葉はもみじ",
		// 2026-10-21T05:00 in Asia/Tokyo.
		previous: [{ text: "合言葉はさくら", until: "2026-10-21" }],
	});
	expect(recall(h, "合言葉").items[0]).not.toHaveProperty("previous");
});

test("marks are carried to the version that replaces a record and vanish with a forget", async () => {
	const h = await setup();
	const first = await saved(h, "服用している薬は一日二回", "medicine", {
		sensitive: true,
		aboutOther: true,
	});
	const marksOf = (itemId: string) =>
		h.store.read((db) =>
			db
				.query(
					"SELECT sensitive, about_other AS aboutOther FROM memory_item_mark WHERE item_id = ?",
				)
				.get(itemId),
		);
	expect(marksOf(first.itemId)).toEqual({ sensitive: 1, aboutOther: 1 });
	// A correction by the user (no marks of its own) inherits them.
	const messageId = await h.say("user", "服用している薬は一日三回になった");
	const corrected = await write(h, (db) =>
		h.memory.correctExplicitInTransaction(db, {
			conversationId: "c1",
			sourceRunId: "run-c",
			messageId,
			quote: "服用している薬は一日三回",
			text: "服用している薬は一日三回",
			polarity: "affirmed",
			target: { itemId: first.itemId },
		}),
	);
	if (corrected.status !== "applied") throw new Error("not applied");
	expect(marksOf(corrected.itemId)).toEqual({ sensitive: 1, aboutOther: 1 });
	// So does a restatement under the same key by the steward's path.
	const readBack = recall(h, "薬").items[0]!;
	expect(readBack).toMatchObject({ sensitive: true, aboutOther: true });
	// The window carries the marks too (the always-on section leaves such records out).
	const window = await h.window();
	expect(window.profile.items[0]).toMatchObject({
		sensitive: true,
		aboutOther: true,
	});
	await h.forget([first.itemId, corrected.itemId]);
	expect(marksOf(first.itemId)).toBeNull();
	expect(marksOf(corrected.itemId)).toBeNull();
});

test("the same words under another key are one record; alike words are saved as another", async () => {
	const h = await setup();
	const one = await saved(h, "猫の名前はミル", "pet.cat.name");
	// Same words (spaces and punctuation aside), other key: the first record is confirmed, no second one.
	const again = await remember(h, "猫の名前は、ミル", "cat_name");
	expect(again).toMatchObject({ status: "unchanged", itemId: one.itemId });
	expect(h.memory.list(true)).toHaveLength(1);
	// Another kind with the same words is another record.
	const other = await saved(h, "猫の名前はミル", "cat.name.habit", {
		kind: "habit",
	});
	expect(other.itemId).not.toBe(one.itemId);
	// Alike but not the same: saved as its own record.
	await saved(h, "猫の名前はミルク", "cat.name.v2");
	expect(h.memory.list(true).filter((i) => i.status === "active")).toHaveLength(
		3,
	);
});

test("an unasked statement of the same words under another key confirms the record; a different value still conflicts", async () => {
	const h = await setup();
	const one = await saved(h, "鍵は靴箱の上にある", "home.key");
	expect(
		await remember(h, "鍵は靴箱の上にある", "key.place", { requested: false }),
	).toMatchObject({ status: "unchanged", itemId: one.itemId });
	expect(
		await remember(h, "鍵は玄関の棚にある", "home.key", { requested: false }),
	).toMatchObject({ status: "rejected", reason: "conflict" });
});

test("saving the input budget leaves the access policy alone: saved answers stay current, the window is built again; the switch still steps it", async () => {
	const h = await setup();
	const defaults = {
		alwaysTokens: 2000,
		alwaysScope: "facts" as const,
	};
	expect(h.memory.status()).toEqual({
		enabled: true,
		healthy: true,
		...defaults,
	});
	expect(h.store.read((db) => h.memory.inputBudgetInTransaction(db))).toEqual(
		defaults,
	);
	const revision = () =>
		h.store.read((db) => h.memory.policyRevisionInTransaction(db));
	const said = await h.exchange("猫の名前はミル", null);
	const item = await h.remember({
		conversationId: "c1",
		messageId: said.userId,
		kind: "personal_fact",
		semanticKey: "cat.name",
		text: "猫の名前はミル",
	});
	// What an answer saved as its sources.
	const input = h.store.read((db) =>
		h.memory.referenceInputs.captureInTransaction(db, {
			messageIds: [said.userId],
			itemIds: [item.id],
		}),
	);
	const isCurrent = () =>
		h.store.read((db) =>
			h.memory.referenceInputs.isCurrentInTransaction(db, input),
		);
	expect(isCurrent()).toBe(true);
	const built = await h.window();
	const before = revision();
	const status = await h.memory.updateSettings({
		alwaysTokens: 4000,
	});
	expect(status).toEqual({
		enabled: true,
		healthy: true,
		...defaults,
		alwaysTokens: 4000,
	});
	expect(revision()).toBe(before);
	expect(isCurrent()).toBe(true);
	// A run in flight is not expired by it either.
	const prepared = h.memory.preparedWindow(built);
	expect(
		h.store.read((db) =>
			h.memory.validateWindowInTransaction(db, "run-x", prepared),
		),
	).toEqual({ ok: true });
	// The window is built again from the budget it holds now.
	const rebuilt = await h.window();
	expect(rebuilt.buildId).not.toBe(built.buildId);
	expect(rebuilt.inputs.budgetKey).toBe("4000:facts");
	// The same values again change nothing.
	await h.memory.updateSettings({ alwaysTokens: 4000 });
	expect(revision()).toBe(before);
	// The switch steps the policy and expires what stood on it.
	await h.memory.setEnabled(false);
	expect(Number(revision())).toBe(Number(before) + 1);
	expect(h.memory.status()).toMatchObject({
		enabled: false,
		alwaysTokens: 4000,
	});
});

test("the settings schema takes any of the settings, at least one, within their ranges", () => {
	expect(settingsSchema.safeParse({ enabled: false }).success).toBe(true);
	expect(
		settingsSchema.safeParse({
			alwaysTokens: 8000,
			alwaysScope: "leanings",
		}).success,
	).toBe(true);
	for (const bad of [
		{},
		{ alwaysTokens: 199 },
		{ alwaysTokens: 8001 },
		{ alwaysScope: "all" },
	])
		expect(settingsSchema.safeParse(bad).success).toBe(false);
});

test("a mark added to a record that stands already takes it out of the published profile at once", async () => {
	const h = await setup();
	const one = await saved(h, "通院している病院は駅前にある", "clinic");
	const first = await h.window();
	expect(first.profile.items[0]).not.toHaveProperty("sensitive");
	// The same words again, now marked: nothing new is written, but the window is cut.
	const again = await remember(h, "通院している病院は駅前にある", "clinic", {
		sensitive: true,
	});
	expect(again).toMatchObject({ status: "unchanged", itemId: one.itemId });
	const next = await h.window();
	expect(next.buildId).not.toBe(first.buildId);
	expect(next.profile.items[0]).toMatchObject({ sensitive: true });
	// Saying it marked again adds nothing and cuts nothing.
	await remember(h, "通院している病院は駅前にある", "clinic", {
		sensitive: true,
	});
	expect((await h.window()).buildId).toBe(next.buildId);
});

test("marksInTransaction returns the marks of the given records only, none for a record without", async () => {
	const h = await setup();
	const sensitive = await saved(h, "通院している病院は駅前にある", "clinic", {
		sensitive: true,
	});
	const other = await saved(h, "田島さんの趣味はカメラ", "tajima", {
		aboutOther: true,
	});
	const both = await saved(h, "母の持病は高血圧", "mother", {
		sensitive: true,
		aboutOther: true,
	});
	const plain = await saved(h, "毎朝コーヒーを飲む", "coffee");
	const marks = h.store.read((db) =>
		h.memory.marksInTransaction(db, [
			sensitive.itemId,
			other.itemId,
			both.itemId,
			plain.itemId,
			"missing",
		]),
	);
	expect(marks).toEqual(
		new Map([
			[sensitive.itemId, { sensitive: true }],
			[other.itemId, { aboutOther: true }],
			[both.itemId, { sensitive: true, aboutOther: true }],
		]),
	);
	expect(h.store.read((db) => h.memory.marksInTransaction(db, []))).toEqual(
		new Map(),
	);
});
