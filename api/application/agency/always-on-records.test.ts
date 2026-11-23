import { expect, test } from "bun:test";
import { saveItem } from "../../domains/memory/test/memory.fixture";
import { settle } from "../../infrastructure/wait-for";
import { agendaFixture, noRecords, type CallKind } from "./always-on.fixture";
import { RECORDS_PASS_EVENTS, readAfter } from "./always-on-records";
import { createAgendaScope, renamed } from "./always-on-scope";
import { staleMemoryRefs } from "./input";
import { goalSlots } from "./goal-agenda";
import type { AgencyHostDeps } from "./host-types";
import {
	RECORD_LIMITS,
	currentRef,
	knownFor,
	marksFor,
	recordsFor,
} from "./always-on-recall";

import {
	candidates,
	exchange,
	found,
	plans,
	questions,
	writes,
} from "./always-on-records.fixture";

test("the records writer runs at once when none is running, with no wait, and reads the exchange", async () => {
	const f = await agendaFixture();
	try {
		await f.start();
		await exchange(f, "a", "来月は箱根へ行く");
		// No clock advance: the pass has already read the exchange.
		const [call] = f.calls("records");
		expect(f.calls("records")).toHaveLength(1);
		expect(call!.prompt).toContain("来月は箱根へ行く");
		await f.advance(60_000);
		expect(f.calls("records")).toHaveLength(1);
	} finally {
		await f.close();
	}
});

test("what comes in while a pass runs is read together by one pass right after it, and nothing else runs again", async () => {
	let release!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	let calls = 0;
	const f = await agendaFixture({
		script: async (kind: CallKind) => {
			if (kind !== "records") return undefined;
			if (++calls === 1) await held;
			return noRecords();
		},
	});
	try {
		await f.start();
		await exchange(f, "a", "来月は箱根へ行く");
		expect(f.calls("records")).toHaveLength(1);
		await exchange(f, "b", "紅葉も見たい");
		await exchange(f, "c", "温泉に入りたい");
		// The first pass is still running: nothing else starts.
		expect(f.calls("records")).toHaveLength(1);
		release();
		await settle();
		const records = f.calls("records");
		expect(records).toHaveLength(2);
		expect(records[1]!.prompt).toContain("紅葉も見たい");
		expect(records[1]!.prompt).toContain("温泉に入りたい");
		// Every line after the position: the first exchange is not read twice.
		expect(records[1]!.prompt).not.toContain("来月は箱根へ行く");
		await settle();
		await f.advance(60_000);
		expect(f.calls("records")).toHaveLength(2);
	} finally {
		await f.close();
	}
});

test("words forgotten before the pass reads them are not read, and a pass that read them is not kept", async () => {
	let release!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	let calls = 0;
	const f = await agendaFixture({
		script: async (kind: CallKind) => {
			if (kind !== "records") return undefined;
			if (++calls === 1) {
				await held;
				return found({
					plans: [
						{
							op: "add",
							ref: null,
							text: "秘密の旅行に行く",
							dueAt: null,
							evidence: ["user-a"],
						},
					],
				});
			}
			return noRecords();
		},
	});
	try {
		await f.start();
		await exchange(f, "a", "秘密の旅行計画がある");
		expect(f.calls("records")).toHaveLength(1);
		await exchange(f, "b", "紅葉を見たい");
		await f.h.memory!.forget({
			conversationId: "ao",
			messageIds: ["user-a"],
			itemIds: [],
		});
		release();
		await settle();
		// The first pass read the words that were forgotten meanwhile: nothing of it is written.
		expect(plans(f)).toEqual([]);
		const records = f.calls("records");
		expect(records.at(-1)!.prompt).not.toContain("秘密の旅行計画");
		expect(records.at(-1)!.prompt).toContain("紅葉を見たい");
	} finally {
		await f.close();
	}
});

test("after the host is closed, a finished pass does not start another", async () => {
	let release!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	const f = await agendaFixture({
		script: async (kind: CallKind) => {
			if (kind !== "records") return undefined;
			await held;
			return noRecords();
		},
	});
	try {
		await f.start();
		await exchange(f, "a", "来月は箱根へ行く");
		await exchange(f, "b", "紅葉も見たい");
		expect(f.calls("records")).toHaveLength(1);
		await f.host.close();
		release();
		await settle();
		expect(f.calls("records")).toHaveLength(1);
	} finally {
		await f.close();
	}
});

test("memories go to the long-term memory (L2) as the user's own, candidates to the candidates (L1), plans and questions to the continuity domain", async () => {
	const f = await agendaFixture({
		script: writes(
			found({
				memories: [
					{
						kind: "preference",
						semanticKey: "drink.coffee.style",
						subject: "self",
						text: "コーヒーはブラックで飲む",
						quote: "ブラック派",
						evidence: "user-a",
					},
				],
				candidates: [
					{ kind: "habit", text: "夜に散歩する", evidence: ["user-a"] },
				],
				plans: [
					{
						op: "add",
						ref: null,
						text: "週末に出かける",
						dueAt: "2026-11-28",
						evidence: ["user-a"],
					},
				],
				questions: [
					{
						op: "answered",
						attribute: "コーヒーの飲み方",
						evidence: ["user-a"],
					},
				],
			}),
		),
	});
	try {
		await f.start();
		await exchange(
			f,
			"a",
			"コーヒーはブラック派なんだよね。夜は散歩する。週末に出かける",
		);
		const item = f.h
			.memory!.list()
			.find((i) => i.text === "コーヒーはブラックで飲む");
		expect(item?.origin).toBe("user_confirmed");
		expect(candidates(f).map((c) => c.value.text)).toContain("夜に散歩する");
		expect(plans(f).map((p) => [p.text, p.dueAt, p.state])).toEqual([
			["週末に出かける", "2026-11-28", "open"],
		]);
		expect(questions(f).map((q) => [q.attribute, q.state])).toEqual([
			["コーヒーの飲み方", "answered"],
		]);
		// Not asked to be remembered: a statement of the user's own accord.
		expect(
			f.h.memory!.list().filter((i) => i.origin !== "user_confirmed"),
		).toEqual([]);
	} finally {
		await f.close();
	}
});

test("a plan the writer was shown is updated and closed through its short reference, an unknown reference is refused", async () => {
	let n = 0;
	const f = await agendaFixture({
		script: (kind: CallKind) => {
			if (kind !== "records") return undefined;
			n++;
			if (n === 1)
				return found({
					plans: [
						{
							op: "add",
							ref: null,
							text: "水曜に歯医者へ行く",
							dueAt: "2026-11-25",
							evidence: ["user-a"],
						},
					],
				});
			if (n === 2)
				return found({
					plans: [
						{
							op: "update",
							ref: "p1",
							text: null,
							dueAt: "2026-11-26",
							evidence: ["user-b"],
						},
						{
							op: "close",
							ref: "p9",
							text: null,
							dueAt: null,
							evidence: ["user-b"],
						},
					],
				});
			return found({
				plans: [
					{
						op: "close",
						ref: "p1",
						text: null,
						dueAt: null,
						evidence: ["user-c"],
					},
				],
			});
		},
	});
	try {
		await f.start();
		await exchange(f, "a", "水曜に歯医者へ行く");
		expect(plans(f).map((p) => p.dueAt)).toEqual(["2026-11-25"]);
		await exchange(f, "b", "歯医者は木曜に変わった");
		expect(plans(f).map((p) => p.dueAt)).toEqual(["2026-11-26"]);
		await exchange(f, "c", "歯医者へ行ってきた");
		expect(plans(f)).toEqual([]);
	} finally {
		await f.close();
	}
});

test("a disagreement with a memory item is kept as an unresolved question resting on that item", async () => {
	const f = await agendaFixture({
		script: writes(
			found({
				conflicts: [
					{ with: "m1", evidence: "user-b", note: "前は紅茶派と言っていた" },
				],
			}),
		),
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
		await exchange(f, "b", "最近は紅茶よりコーヒー");
		const conflict = plans(f).find((p) => p.kind === "open_question");
		expect(conflict?.memoryItemIds).toEqual([item.id]);
		// The memory itself is not changed (a disagreement is not a correction).
		expect(f.h.memory!.list().map((i) => i.text)).toEqual(["紅茶が好き"]);
		const records = f.h.store.read(() =>
			recordsFor(f.deps, { purpose: "plan" }, []),
		);
		expect(records.conflicts?.map((c) => c.text)).toEqual([
			"前は紅茶派と言っていた",
		]);
		expect(records.plans).toEqual([]);
	} finally {
		await f.close();
	}
});

test("a pass that fails does not move the position and sets no timer: the same words are read again when the next reply is heard", async () => {
	let n = 0;
	const f = await agendaFixture({
		script: (kind: CallKind) => {
			if (kind !== "records") return undefined;
			if (++n <= 1) throw new Error("fixture_failure");
			return noRecords();
		},
	});
	try {
		await f.start();
		await exchange(f, "a", "来月は箱根へ行く");
		expect(f.calls("records")).toHaveLength(1);
		// No wait that means nothing: time passing reads nothing again.
		await f.advance(60_000);
		await f.advance(60_000);
		expect(f.calls("records")).toHaveLength(1);
		await exchange(f, "b", "紅葉も見たい");
		const records = f.calls("records");
		expect(records).toHaveLength(2);
		expect(records[1]!.prompt).toContain("来月は箱根へ行く");
		expect(records[1]!.prompt).toContain("紅葉も見たい");
		// Kept now: nothing is read again.
		await f.advance(60_000);
		expect(f.calls("records")).toHaveLength(2);
	} finally {
		await f.close();
	}
});

test("a pass the main conversation called off leaves the position and reads the same words when the conversation is free", async () => {
	let n = 0;
	const f = await agendaFixture({
		script: (kind: CallKind) => {
			if (kind !== "records") return undefined;
			if (++n === 1) throw new DOMException("preempted", "AbortError");
			return noRecords();
		},
	});
	try {
		await f.start();
		f.setBusy(true);
		await exchange(f, "a", "来月は箱根へ行く");
		expect(f.calls("records")).toHaveLength(1);
		// Still busy: it is not tried again against the conversation.
		await f.advance(10_000);
		expect(f.calls("records")).toHaveLength(1);
		f.setBusy(false);
		await settle();
		const records = f.calls("records");
		expect(records).toHaveLength(2);
		expect(records[1]!.prompt).toContain("来月は箱根へ行く");
	} finally {
		await f.close();
	}
});

test("a restart reads from the saved position: the words read before are not read again, the ones that were not are", async () => {
	const f = await agendaFixture();
	try {
		await f.start();
		await exchange(f, "a", "来月は箱根へ行く");
		expect(f.calls("records")).toHaveLength(1);
		await f.host.attend("ao");
		await settle();
		await f.restart();
		// Nothing new: no call.
		expect(f.calls("records")).toHaveLength(1);
		await f.user("user-b", "ao", "紅葉も見たい");
		await f.restart();
		const records = f.calls("records");
		expect(records).toHaveLength(2);
		expect(records[1]!.prompt).toContain("紅葉も見たい");
		expect(records[1]!.prompt).not.toContain("来月は箱根へ行く");
	} finally {
		await f.close();
	}
});

test("one pass reads at most the limit of words; the rest is read by the next pass", async () => {
	const f = await agendaFixture();
	try {
		await f.start();
		await f.user("user-0", "ao", "最初の話");
		for (let i = 1; i <= RECORDS_PASS_EVENTS + 3; i++)
			await f.user(`user-${i}`, "ao", `話${i}`);
		const read = f.h.store.read((db) => readAfter(f.deps, db, "ao", 0));
		expect(read.said).toHaveLength(RECORDS_PASS_EVENTS);
		expect(read.more).toBe(true);
		const next = f.h.store.read((db) => readAfter(f.deps, db, "ao", read.to));
		expect(next.said[0]!.id).toBe(`user-${RECORDS_PASS_EVENTS}`);
	} finally {
		await f.close();
	}
});

test("the state has no profile: a checkpoint of before is read without it, and the next save has none", async () => {
	const f = await agendaFixture();
	try {
		await f.start();
		await f.user("user-a", "ao", "来月は箱根へ行く");
		await f.host.attend("ao");
		await settle();
		await f.host.close();
		await f.h.store.write((db) => {
			const row = db
				.query(
					"SELECT snapshot_json FROM dialogue_agency_state WHERE conversation_id='ao'",
				)
				.get() as { snapshot_json: string };
			const snapshot = JSON.parse(row.snapshot_json);
			snapshot.profile = {
				markdown: "古いメモ",
				base: "",
				passes: [{ markdown: "古いメモ", sources: ["user-a"] }],
			};
			db.query(
				"UPDATE dialogue_agency_state SET snapshot_json=? WHERE conversation_id='ao'",
			).run(JSON.stringify(snapshot));
		});
		await f.restart();
		expect(f.host.inspect("ao")).not.toBeNull();
		expect(f.host.inspect("ao")!.snapshot).not.toHaveProperty("profile");
		await f.host.attend("ao");
		await f.advance(1);
		await f.host.close();
		const saved = f.h.store.read(
			(db) =>
				db
					.query(
						"SELECT snapshot_json FROM dialogue_agency_state WHERE conversation_id='ao'",
					)
					.get() as { snapshot_json: string },
		);
		expect(saved.snapshot_json).not.toContain("古いメモ");
		expect(JSON.parse(saved.snapshot_json)).not.toHaveProperty("profile");
	} finally {
		await f.close();
	}
});

test("known is what bears on the call without what is suppressed or excluded; records and marks carry the plans, goals' slots, ledger and the marks", async () => {
	const f = await agendaFixture();
	try {
		await f.start();
		await f.user("user-a", "ao", "コーヒーは好き。猫を飼っている。旅行が好き");
		const save = (semanticKey: string, text: string) =>
			saveItem(f.h.store, f.h.memory!, {
				conversationId: "ao",
				messageId: "user-a",
				kind: "preference",
				semanticKey,
				text,
			});
		const coffee = await save("drink.coffee", "コーヒーは好き");
		const cat = await save("pet.cat", "猫を飼っている");
		const travel = await save("hobby.travel", "旅行が好き");
		const known = (call: Parameters<typeof knownFor>[1], said: string[] = []) =>
			knownFor(f.deps, call, said, f.now).map((k) => k.id);
		// A draft is given what bears on its topic only.
		expect(
			known({
				purpose: "compose",
				item: { kind: "talk", text: "コーヒーの話", topic: null },
			}),
		).toEqual([coffee.id]);
		// A plan is given what bears on the latest words first, then the newest.
		const planned = known({ purpose: "plan" }, ["猫を飼っている話をした"]);
		expect(planned[0]).toBe(cat.id);
		expect(planned).toContain(coffee.id);
		expect(planned.length).toBeLessThanOrEqual(12);
		// Suppressed: left out of every call, marked for the agent.
		await f.h.store.write((db) => {
			const out = f.h.memory!.suppressInTransaction(db, {
				conversationId: "ao",
				sourceRunId: "run-s",
				target: { itemId: cat.id },
			});
			expect(out.status).toBe("applied");
			expect(
				f.h.memory!.suppressInTransaction(db, {
					conversationId: "ao",
					sourceRunId: "run-s",
					target: { term: "旅行" },
				}).status,
			).toBe("applied");
		});
		expect(
			known({ purpose: "plan" }, ["猫を飼っている話をした"]),
		).not.toContain(cat.id);
		// The agent cites the version of the travel record: a correction of it puts the item under review.
		const holds = {
			agent: { view: () => ({ items: [{ refs: [`memory:${travel.id}`] }] }) },
		} as never;
		let marks = marksFor(f.deps, holds);
		expect(marks.suppressedRefs).toEqual([`memory:${cat.id}`]);
		expect(marks.suppressedTopics).toEqual(["旅行"]);
		expect(marks.underReview).toEqual([]);
		// Excluded (a forget on its way): not listed at all.
		await f.h.store.write((db) =>
			f.h.memory!.excludeForForgetInTransaction(db, {
				conversationId: "ao",
				sourceRunId: "run-x",
				targets: [{ itemId: coffee.id }],
			}),
		);
		expect(known({ purpose: "plan" })).not.toContain(coffee.id);
		// A corrected record is under review.
		await f.h.store.write((db) =>
			f.h.memory!.correctExplicitInTransaction(db, {
				conversationId: "ao",
				sourceRunId: "run-c",
				messageId: "user-a",
				quote: "旅行が好き",
				text: "旅行が大好き",
				polarity: "affirmed",
				target: { itemId: travel.id },
			}),
		);
		marks = marksFor(f.deps, holds);
		expect(marks.underReview).toEqual([`memory:${travel.id}`]);
		// The plans, the unresolved questions and the ledger.
		await f.h.store.write((db) => {
			f.deps.continuity.plans.addInTransaction(db, {
				conversationId: "ao",
				kind: "plan",
				text: "水曜に歯医者",
				dueAt: "2026-11-25",
				evidence: { messages: [{ messageId: "user-a" }] },
			});
			f.deps.continuity.plans.addInTransaction(db, {
				conversationId: "ao",
				kind: "plan",
				text: "旅行の計画",
				dueAt: null,
				evidence: { messages: [{ messageId: "user-a" }] },
			});
			f.deps.continuity.questions.recordInTransaction(db, {
				conversationId: "ao",
				attribute: "血液型",
				state: "declined",
				evidence: { messages: [{ messageId: "user-a" }] },
			});
		});
		const planRecords = recordsFor(f.deps, { purpose: "plan" }, []);
		// A plan about a suppressed topic is not given.
		expect(planRecords.plans?.map((p) => p.text)).toEqual(["水曜に歯医者"]);
		expect(planRecords.questions).toEqual([
			{ attribute: "血液型", state: "declined" },
		]);
		expect(RECORD_LIMITS.plans).toBeGreaterThanOrEqual(1);
		expect(
			recordsFor(f.deps, { purpose: "ask_check", asks: ["血液型は？"] }, []),
		).toEqual({ questions: [{ attribute: "血液型", state: "declined" }] });
	} finally {
		await f.close();
	}
});

test("what rests on a corrected or suppressed record is not planned, written or said: the item stays on the list, held", async () => {
	for (const mark of ["none", "corrected", "suppressed"] as const) {
		let memoryRef = "";
		let composeFails = true;
		const f = await agendaFixture({
			script(kind) {
				if (kind === "plan")
					return {
						add: [
							{
								kind: "talk",
								text: "コーヒーの話",
								refs: ["source", memoryRef],
								value: 5,
								reason: "fixture",
								topic: "コーヒー",
							},
						],
						drop: [],
						focus: "コーヒー",
					};
				if (kind === "compose") {
					if (composeFails) throw new Error("fixture_failure");
					return {
						utterance: "コーヒーの話をしませんか",
						emotion: null,
						decline: null,
						questions: 0,
						choice: false,
					};
				}
				return undefined;
			},
		});
		try {
			await f.user("source", "ao", "コーヒーはブラックで飲む");
			const item = await saveItem(f.h.store, f.h.memory!, {
				conversationId: "ao",
				messageId: "source",
				kind: "preference",
				semanticKey: "drink.coffee",
				text: "コーヒーはブラックで飲む",
			});
			memoryRef = `memory:${item.id}`;
			const c = createAgendaScope({
				deps: f.deps,
				id: "ao",
				epoch: 0,
				now: () => f.now,
				text: () => null,
				kick: () => {},
			});
			c.agent.observe({
				id: "source",
				who: "user",
				text: "コーヒーの話",
				at: f.now,
			});
			let at = f.now + 15_000;
			await c.agent.step(
				at,
				() => ({ busy: false }),
				new AbortController().signal,
			);
			expect(c.agent.view().items.map((i) => i.text)).toEqual(["コーヒーの話"]);
			if (mark === "corrected")
				await f.h.store.write((db) =>
					f.h.memory!.correctExplicitInTransaction(db, {
						conversationId: "ao",
						sourceRunId: "run-c",
						messageId: "source",
						quote: "ブラックで飲む",
						text: "コーヒーはミルク入りで飲む",
						polarity: "affirmed",
						target: { itemId: item.id },
					}),
				);
			if (mark === "suppressed")
				await f.h.store.write((db) =>
					f.h.memory!.suppressInTransaction(db, {
						conversationId: "ao",
						sourceRunId: "run-s",
						target: { itemId: item.id },
					}),
				);
			composeFails = false;
			const before = f.calls("compose").length;
			at += 60_000;
			const out = await c.agent.step(
				at,
				() => ({ busy: false }),
				new AbortController().signal,
			);
			const composed = f.calls("compose").length - before;
			if (mark === "none") {
				expect(composed).toBeGreaterThan(0);
			} else {
				expect(composed).toBe(0);
				expect(out.tickets.filter((t) => t.kind === "speak")).toEqual([]);
			}
		} finally {
			await f.close();
		}
	}
});

test("a version a consolidation replaced is the version that took its place: its references are not stale, are followed and are saved as the new one; a correction or a forget is not", () => {
	const feed = {
		changesInTransaction: () => ({
			changes: [
				{
					seq: 1,
					targetType: "state_item",
					targetId: "a",
					changeKind: "consolidation",
					successorId: "b",
				},
				{
					seq: 2,
					targetType: "state_item",
					targetId: "b",
					changeKind: "consolidation",
					successorId: "c",
				},
				{
					seq: 3,
					targetType: "state_item",
					targetId: "x",
					changeKind: "correction",
					successorId: "y",
				},
			],
			nextAfterSeq: 3,
			hasMore: false,
		}),
		captureInTransaction: (_db: unknown, input: { itemIds: string[] }) => ({
			sources: input.itemIds
				.filter((id) => id === "c")
				.map((id) => `memory:${id}`),
			complete: true,
		}),
	};
	const deps = {
		memory: {
			status: () => ({ enabled: true, healthy: true }),
			referenceInputs: feed,
		},
	} as unknown as AgencyHostDeps;
	const db = {} as never;
	expect(currentRef(deps, db, "memory:a")).toBe("memory:c");
	expect(currentRef(deps, db, "memory:x")).toBe("memory:x");
	expect(currentRef(deps, db, "user-a")).toBe("user-a");
	// Stale is what is not current after the consolidations: the corrected and the gone are, the consolidated is not.
	expect(
		staleMemoryRefs(deps, db, [
			"memory:a",
			"memory:b",
			"memory:c",
			"memory:x",
			"memory:z",
		]),
	).toEqual(["memory:x", "memory:z"]);
	const snapshot = {
		version: 1,
		at: 0,
		n: 1,
		quiet: { speechUntil: null, allUntil: null },
		items: [
			{
				id: "a1",
				kind: "research",
				text: "t",
				refs: ["user-a", "memory:a"],
				value: 3,
				reason: "",
				requested: true,
				promised: true,
				noteId: null,
				createdAt: 0,
				declines: 0,
			},
		],
	} as never;
	expect(
		renamed(snapshot, new Map([["memory:a", "memory:c"]])).items[0]!.refs,
	).toEqual(["user-a", "memory:c"]);
});

test("a question the sleeping layer left open, with or without a memory item behind it, is given to the plan", async () => {
	const f = await agendaFixture();
	try {
		await f.start();
		await f.user("user-a", "ao", "毎朝ストレッチを続けたい");
		await f.h.store.write((db) =>
			f.deps.continuity.plans.addInTransaction(db, {
				conversationId: "ao",
				kind: "open_question",
				text: "毎朝のストレッチを目標にしてよいか",
				evidence: { messages: [{ messageId: "user-a" }] },
			}),
		);
		const records = recordsFor(f.deps, { purpose: "plan" }, []);
		expect(records.plans?.map((p) => p.text)).toEqual([
			"毎朝のストレッチを目標にしてよいか",
		]);
		expect(records.conflicts).toEqual([]);
	} finally {
		await f.close();
	}
});

test("the goals in the slots are given to the state in slot order, without a goal resting on a message the memory blocked or a withdrawn one", () => {
	const goal = (goalId: string, status: string, desiredState: string) => ({
		goalId,
		status,
		desiredState,
	});
	const deps = {
		memory: {
			isBlockedInTransaction: (_db: unknown, id: string) => id === "gone",
		},
		agendaGoals: {
			store: {
				list: () => [
					{ slot: 1, goal: goal("g1", "adopted", "毎朝ストレッチを続ける") },
					{ slot: 2, goal: null },
					{ slot: 3, goal: goal("g3", "adopted", "忘れられた目標") },
					{ slot: 4, goal: goal("g4", "withdrawn", "取り下げた目標") },
					{ slot: 5, goal: goal("g5", "proposed", "提案中の目標") },
				],
			},
			sourceMessageIds: (_db: unknown, id: string) =>
				id === "g3" ? ["gone"] : ["kept"],
		},
	} as unknown as AgencyHostDeps;
	expect(goalSlots(deps, {} as never)).toEqual([
		{ slot: 1, text: "毎朝ストレッチを続ける", state: "進行中" },
		{ slot: 5, text: "提案中の目標", state: "提案中" },
	]);
});
