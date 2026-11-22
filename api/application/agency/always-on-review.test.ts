import { expect, test } from "bun:test";
import { saveItem } from "../../domains/memory/test/memory.fixture";
import { settle } from "../../infrastructure/wait-for";
import {
	agendaFixture,
	noRecords,
	promiseResearch,
	replyWith,
	type CallKind,
} from "./always-on.fixture";
import { wordsOf } from "./always-on-feed";
import { backfillStart, readAfter } from "./always-on-records";
import { marksFor, recordsFor, slotGoals } from "./always-on-recall";
import type { AgencyHostDeps } from "./host-types";

type Fixture = Awaited<ReturnType<typeof agendaFixture>>;
const found = (over: Record<string, unknown[]>) => ({
	...noRecords(),
	...over,
});
const exchange = async (f: Fixture, n: string, text: string) => {
	await f.user(`user-${n}`, "ao", text);
	await f.assistant(`answer-${n}`, "いいですね。", "ao");
};
const plans = (f: Fixture) =>
	f.h.store.read((db) => f.deps.continuity.plans.listInTransaction(db));
/** The agent of a scope that cites these references (the marks are read for what the agent holds). */
const citing = (...refs: string[]) =>
	({ agent: { view: () => ({ items: [{ refs }] }) } }) as never;

test("what the memory withholds is not read as words: not by the words' reader, and not by the goals", async () => {
	const f = await agendaFixture();
	try {
		await f.start();
		await f.user("user-a", "ao", "来月は箱根へ行く");
		const read = () => f.h.store.read((db) => wordsOf(f.deps, db, "user-a"));
		expect(read()?.text).toContain("箱根");
		// One test for what is excluded while its forget is on its way: the memory says which messages it withholds.
		const memory = f.deps.memory;
		(f.deps as { memory: unknown }).memory = {
			...memory,
			withheldMessagesInTransaction: (_db: unknown, ids: readonly string[]) =>
				ids.filter((id) => id === "user-a"),
		};
		expect(read()).toBeNull();
		// The goals: a goal resting on a withheld message is neither in the slots nor given to a call.
		const goal = (goalId: string, text: string) => ({
			goalId,
			status: "adopted",
			desiredState: text,
		});
		(f.deps as { agendaGoals: unknown }).agendaGoals = {
			store: {
				list: () => [
					{ slot: 1, goal: goal("g1", "毎朝ストレッチ") },
					{ slot: 2, goal: goal("g2", "箱根の旅の計画") },
				],
			},
			sourceMessageIds: (_db: unknown, id: string) =>
				id === "g2" ? ["user-a"] : ["user-z"],
		};
		expect(
			f.h.store.read((db) => slotGoals(f.deps, db)).map((g) => g.text),
		).toEqual(["毎朝ストレッチ"]);
		expect(
			recordsFor(f.deps, { purpose: "plan" }, []).goals?.map((g) => g.text),
		).toEqual(["毎朝ストレッチ"]);
	} finally {
		await f.close();
	}
});

test("records the memory excluded leave the agent at once, with a reference or without: its items, words and notes", async () => {
	const f = await agendaFixture();
	try {
		await f.start();
		await f.user("user-a");
		await replyWith(f, promiseResearch);
		await f.host.attend("ao");
		await settle();
		expect(f.host.inspect("ao")!.snapshot.agent.items).toHaveLength(1);
		// Another conversation's records are not this one's: nothing is touched.
		await f.h.store.write((db) =>
			f.host.dialoguePort.memoryExcludedInTransaction(db, {
				conversationId: "ao",
				itemIds: [],
				messageIds: ["not-cited"],
			}),
		);
		expect(f.host.inspect("ao")!.snapshot.agent.items).toHaveLength(1);
		await f.h.store.write((db) =>
			f.host.dialoguePort.memoryExcludedInTransaction(db, {
				conversationId: "ao",
				itemIds: [],
				messageIds: ["user-a"],
			}),
		);
		expect(f.host.inspect("ao")!.snapshot.agent.items).toHaveLength(0);
	} finally {
		await f.close();
	}
});

test("the words of a request to the memory (and of its taking back) are not read by the records writer, and nothing is written from them", async () => {
	const f = await agendaFixture({
		script: (kind: CallKind) =>
			kind === "records"
				? found({
						plans: [
							{
								op: "add",
								ref: null,
								text: "水曜に歯医者",
								dueAt: null,
								evidence: ["user-a", "user-b"],
							},
						],
					})
				: undefined,
	});
	try {
		await f.start();
		await f.user("user-a", "ao", "覚えて、水曜に歯医者に行く");
		await f.h.store.write((db) =>
			f.deps.continuity.events.appendInTransaction(db, {
				conversationId: "ao",
				at: "2026-11-23 10:00:00",
				type: "acted",
				by: "agent",
				fields: { action: "memory.request", kind: "remember" },
				messageIds: ["user-a"],
			}),
		);
		await exchange(f, "b", "水曜は歯医者のあと、散歩する");
		const [call] = f.calls("records");
		expect(call!.prompt).toContain("散歩する");
		expect(call!.prompt).not.toContain("覚えて、水曜に歯医者");
		// The writer cited the request's words too: they are not in its input, so what rests on them is refused.
		expect(plans(f).flatMap((p) => p.evidence.map((e) => e.messageId))).toEqual(
			["user-b"],
		);
	} finally {
		await f.close();
	}
});

test("a statement the memory refuses as a disagreement with a version in force is not written: it is an unresolved question on that version", async () => {
	const f = await agendaFixture({
		script: (kind: CallKind) =>
			kind === "records"
				? found({
						memories: [
							{
								kind: "preference",
								semanticKey: "drink.tea",
								subject: "self",
								text: "コーヒーのほうが好き",
								quote: "コーヒーのほうが好き",
								evidence: "user-b",
							},
						],
					})
				: undefined,
	});
	try {
		await f.start();
		await f.user("user-a", "ao", "紅茶が好き");
		const item = await saveItem(f.h.store, f.h.memory!, {
			conversationId: "ao",
			messageId: "user-a",
			kind: "preference",
			semanticKey: "drink.tea",
			text: "紅茶が好き",
		});
		const memory = f.deps.memory;
		(f.deps as { memory: unknown }).memory = {
			...memory,
			// The memory's refusal for a statement of the user's own accord that disagrees with a version in force.
			rememberExplicitInTransaction: () => ({
				status: "rejected",
				reason: "conflict",
				existingId: item.id,
			}),
		};
		await exchange(f, "b", "最近はコーヒーのほうが好き");
		expect(f.h.memory!.list().map((i) => i.text)).toEqual(["紅茶が好き"]);
		const open = plans(f).filter((p) => p.kind === "open_question");
		expect(open.map((p) => p.memoryItemIds)).toEqual([[item.id]]);
		expect(open[0]!.text).toContain("コーヒーのほうが好き");
		const records = recordsFor(f.deps, { purpose: "plan" }, []);
		expect(records.conflicts).toHaveLength(1);
	} finally {
		await f.close();
	}
});

test("the position is saved in the transaction of what the pass wrote, and it survives a revoke of the checkpoint", async () => {
	const f = await agendaFixture({
		script: (kind: CallKind) =>
			kind === "records"
				? found({
						plans: [
							{
								op: "add",
								ref: null,
								text: "来月は箱根へ行く",
								dueAt: null,
								evidence: ["user-a"],
							},
						],
					})
				: undefined,
	});
	try {
		await f.start();
		await exchange(f, "a", "来月は箱根へ行く");
		// Not saved by a checkpoint of the host: the pass's own transaction saved it, beside its writes.
		const row = () =>
			f.h.store.read(
				(db) =>
					db
						.query(
							"SELECT idle_json FROM dialogue_agency_state WHERE conversation_id='ao'",
						)
						.get() as { idle_json: string | null } | null,
			);
		const saved = JSON.parse(row()!.idle_json!) as { recordsSeq: number };
		expect(plans(f)).toHaveLength(1);
		expect(saved.recordsSeq).toBeGreaterThan(0);
		await f.host.close();
		// The checkpoint is revoked (the settings changed): what the agency remembers goes, the reading place does not.
		await f.h.store.write((db) =>
			db
				.query(
					"UPDATE dialogue_agency_state SET settings_digest='another host' WHERE conversation_id='ao'",
				)
				.run(),
		);
		await f.user("user-b", "ao", "紅葉も見たい");
		await f.restart();
		// The reply to it is heard: the scope (made again, with no checkpoint) reads from where it stopped.
		await f.assistant("answer-b", "いいですね。", "ao");
		const records = f.calls("records");
		expect(records).toHaveLength(2);
		expect(records[1]!.prompt).toContain("紅葉も見たい");
		expect(records[1]!.prompt).not.toContain("来月は箱根へ行く");
	} finally {
		await f.close();
	}
});

test("with no known position a conversation is read from a little before its end, not skipped", async () => {
	const f = await agendaFixture();
	try {
		await f.start();
		for (let i = 1; i <= 20; i++) await f.user(`user-${i}`, "ao", `話${i}`);
		const from = f.h.store.read((db) => backfillStart(f.deps, db, "ao"));
		const read = f.h.store.read((db) => readAfter(f.deps, db, "ao", from));
		// The last 16 messages of 20: the first four are not read, the rest are (in passes of the limit).
		expect(read.said[0]!.id).toBe("user-5");
		expect(
			f.h.store.read((db) => backfillStart(f.deps, db, "no-such-conversation")),
		).toBe(0);
	} finally {
		await f.close();
	}
});

test("the candidates already noted are shown to the writer, so it does not note them again", async () => {
	let n = 0;
	const f = await agendaFixture({
		script: (kind: CallKind) => {
			if (kind !== "records") return undefined;
			return ++n === 1
				? found({
						candidates: [
							{ kind: "habit", text: "夜に散歩する", evidence: ["user-a"] },
						],
					})
				: noRecords();
		},
	});
	try {
		await f.start();
		await exchange(f, "a", "最近は夜に散歩することが多い");
		await exchange(f, "b", "今夜も散歩した");
		const [, second] = f.calls("records");
		expect(second!.prompt).toContain("夜に散歩する");
		expect(second!.prompt).toMatch(/"ref":"c1"/u);
	} finally {
		await f.close();
	}
});

test("under review: only the corrected versions that the agent's items cite, and the plans that stand on one; an item made again on the current version is not", async () => {
	const f = await agendaFixture();
	try {
		await f.start();
		await f.user("user-a", "ao", "コーヒーはブラックで飲む");
		const old = await saveItem(f.h.store, f.h.memory!, {
			conversationId: "ao",
			messageId: "user-a",
			kind: "preference",
			semanticKey: "drink.coffee",
			text: "コーヒーはブラックで飲む",
		});
		// A plan that stands on the version about to be corrected.
		const plan = await f.h.store.write((db) =>
			f.deps.continuity.plans.addInTransaction(db, {
				conversationId: "ao",
				kind: "plan",
				text: "コーヒー豆を買う",
				evidence: {
					messages: [{ messageId: "user-a" }],
					memoryItemIds: [old.id],
				},
			}),
		);
		await f.h.store.write((db) =>
			f.h.memory!.correctExplicitInTransaction(db, {
				conversationId: "ao",
				sourceRunId: "run-c",
				messageId: "user-a",
				quote: "ブラックで飲む",
				text: "コーヒーはミルク入りで飲む",
				polarity: "affirmed",
				target: { itemId: old.id },
			}),
		);
		const current = f.h.memory!.list().find((i) => i.status === "active")!;
		await settle();
		// The agent's item cites the corrected version: under review; the plan too. The corrected version no item
		// cites is not marked, and one made again on the current version is not.
		expect(marksFor(f.deps, citing(`memory:${old.id}`)).underReview).toEqual([
			`memory:${old.id}`,
			`plan:${plan.id}`,
		]);
		await settle();
		expect(marksFor(f.deps, citing()).underReview).toEqual([`plan:${plan.id}`]);
		await settle();
		expect(
			marksFor(f.deps, citing(`memory:${current.id}`)).underReview,
		).toEqual([`plan:${plan.id}`]);
	} finally {
		await f.close();
	}
});

test("the marks are read once for a run of choices, and again after it; a read that fails fails the call, nothing is let through", async () => {
	const f = await agendaFixture();
	try {
		await f.start();
		let listed = 0;
		let broken = false;
		const memory = f.deps.memory;
		(f.deps as { memory: unknown }).memory = {
			...memory,
			status: () => ({ enabled: true, healthy: true }),
			suppressionsInTransaction: () => {
				if (broken) throw new Error("memory_blocked");
				return {
					terms: [],
					facts: [{ subject: "self", kind: "preference", semanticKey: "x" }],
				};
			},
			list: (...args: unknown[]) => {
				listed++;
				return (memory.list as (...a: unknown[]) => unknown[])(...args);
			},
		};
		const scope = citing();
		// The package asks at every choice: one read serves the whole synchronous run.
		marksFor(f.deps, scope);
		marksFor(f.deps, scope);
		marksFor(f.deps, scope);
		expect(listed).toBe(1);
		await settle();
		marksFor(f.deps, scope);
		expect(listed).toBe(2);
		await settle();
		broken = true;
		expect(() => marksFor(f.deps, scope)).toThrow("memory_blocked");
		expect(() => recordsFor(f.deps, { purpose: "plan" }, [])).toThrow(
			"memory_blocked",
		);
	} finally {
		await f.close();
	}
});

test("withheld goals stay out of the slots when the memory cannot say (no such operation): only blocked messages count", () => {
	const deps = {
		memory: {
			isBlockedInTransaction: (_db: unknown, id: string) => id === "gone",
		},
		agendaGoals: {
			store: {
				list: () => [
					{
						slot: 1,
						goal: { goalId: "g", status: "adopted", desiredState: "目標" },
					},
				],
			},
			sourceMessageIds: () => ["gone"],
		},
	} as unknown as AgencyHostDeps;
	expect(slotGoals(deps, {} as never)).toEqual([]);
});
