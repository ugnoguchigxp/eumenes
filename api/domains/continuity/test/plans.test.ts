import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { createContinuityService, migrations } from "..";
import type { EvidenceInput } from "../contracts/plans";

const say = (...ids: string[]): EvidenceInput => ({
	messages: ids.map((messageId) => ({ messageId })),
});

function setup(now = { at: "2026-11-22T09:00:00.000Z" }) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-plans-"));
	const store = openStore(join(dir, "db.sqlite3"), [...migrations]);
	let n = 0;
	const service = createContinuityService(
		() => now.at,
		() => `id${++n}`,
	);
	return {
		store,
		service,
		now,
		plans: service.plans,
		questions: service.questions,
		done: async () => {
			await store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("add, update and close a plan with evidence; the change is a new revision", async () => {
	const t = setup();
	const added = await t.store.write((db) =>
		t.plans.addInTransaction(db, {
			conversationId: "c1",
			kind: "plan",
			text: "水曜に歯医者",
			dueAt: "2026-11-25",
			evidence: {
				messages: [{ messageId: "m1", quote: "来週の水曜は歯医者" }],
			},
		}),
	);
	expect(added).toMatchObject({
		kind: "plan",
		state: "open",
		revision: 1,
		dueAt: "2026-11-25",
		lastTouchedAt: "2026-11-22T09:00:00.000Z",
		evidence: [
			{ conversationId: "c1", messageId: "m1", quote: "来週の水曜は歯医者" },
		],
	});
	t.now.at = "2026-11-23T09:00:00.000Z";
	const updated = await t.store.write((db) =>
		t.plans.updateInTransaction(db, added.id, {
			text: "木曜に歯医者",
			dueAt: "2026-11-26",
			evidence: say("m2"),
			expectedRevision: 1,
		}),
	);
	expect(updated).toMatchObject({
		text: "木曜に歯医者",
		dueAt: "2026-11-26",
		revision: 2,
		lastTouchedAt: "2026-11-23T09:00:00.000Z",
	});
	expect(updated?.evidence.map((e) => e.messageId)).toEqual(["m1", "m2"]);
	// A stale revision changes nothing.
	expect(
		await t.store.write((db) =>
			t.plans.updateInTransaction(db, added.id, {
				text: "x plan",
				evidence: say("m3"),
				expectedRevision: 1,
			}),
		),
	).toBeNull();
	// null clears the date, undefined keeps it.
	const cleared = await t.store.write((db) =>
		t.plans.updateInTransaction(db, added.id, {
			dueAt: null,
			evidence: say("m3"),
		}),
	);
	expect(cleared).toMatchObject({ text: "木曜に歯医者", dueAt: null });
	const closed = await t.store.write((db) =>
		t.plans.closeInTransaction(db, added.id, { evidence: say("m4") }),
	);
	expect(closed).toMatchObject({ state: "closed", revision: 4 });
	expect(t.store.read((db) => t.plans.listInTransaction(db))).toEqual([]);
	expect(
		t.store.read((db) => t.plans.listInTransaction(db, { states: ["closed"] })),
	).toHaveLength(1);
	// A closed plan is not changed or closed again.
	expect(
		await t.store.write((db) =>
			t.plans.closeInTransaction(db, added.id, { evidence: say("m5") }),
		),
	).toBeNull();
	expect(
		await t.store.write((db) =>
			t.plans.updateInTransaction(db, added.id, {
				text: "復活 plan",
				evidence: say("m5"),
			}),
		),
	).toBeNull();
	await t.done();
});

test("writes without evidence or with a bad text, date or kind are refused", async () => {
	const t = setup();
	const base = {
		conversationId: "c1",
		kind: "plan" as const,
		text: "予定",
		evidence: say("m1"),
	};
	const refuse = (input: Parameters<typeof t.plans.addInTransaction>[1]) =>
		t.store
			.write((db) => t.plans.addInTransaction(db, input))
			.then(
				() => "accepted",
				(error: Error) => error.message,
			);
	expect(await refuse({ ...base, evidence: { messages: [] } })).toBe(
		"invalid_continuity_evidence",
	);
	expect(await refuse({ ...base, evidence: say("  ") })).toBe(
		"invalid_continuity_evidence",
	);
	expect(await refuse({ ...base, text: "  " })).toBe("invalid_plan_text");
	expect(await refuse({ ...base, text: "あ".repeat(501) })).toBe(
		"invalid_plan_text",
	);
	expect(await refuse({ ...base, dueAt: "来週" })).toBe("invalid_plan_due");
	expect(await refuse({ ...base, dueAt: "2026-13-01" })).toBe(
		"invalid_plan_due",
	);
	expect(await refuse({ ...base, kind: "memo" as never })).toBe(
		"invalid_plan_kind",
	);
	// A memory item alone is evidence too.
	expect(
		await refuse({
			...base,
			evidence: { messages: [], memoryItemIds: ["i1"] },
		}),
	).toBe("accepted");
	const open = t.store.read((db) => t.plans.listInTransaction(db));
	expect(open).toHaveLength(1);
	expect(open[0]?.memoryItemIds).toEqual(["i1"]);
	// close and update need evidence too.
	await expect(
		t.store.write((db) =>
			t.plans.closeInTransaction(db, open[0]?.id ?? "", {
				evidence: { messages: [] },
			}),
		),
	).rejects.toThrow("invalid_continuity_evidence");
	await expect(
		t.store.write((db) =>
			t.plans.updateInTransaction(db, open[0]?.id ?? "", {
				evidence: say("m1"),
			}),
		),
	).rejects.toThrow("invalid_plan_update");
	await t.done();
});

test("the list is soonest first, then undated by the latest touch; the caller cuts it", async () => {
	const t = setup();
	const add = (
		text: string,
		dueAt: string | null,
		kind: "plan" | "intent" = "plan",
		conversationId = "c1",
	) =>
		t.store.write((db) =>
			t.plans.addInTransaction(db, {
				conversationId,
				kind,
				text,
				dueAt,
				evidence: say(`m-${text}`),
			}),
		);
	await add("late plan", "2026-12-01");
	t.now.at = "2026-11-22T10:00:00.000Z";
	await add("undated old", null);
	t.now.at = "2026-11-22T11:00:00.000Z";
	await add("undated new", null, "intent");
	await add("soon plan", "2026-11-23T09:00");
	await add("other conv", "2026-11-24", "plan", "c2");
	const texts = (query?: Parameters<typeof t.plans.listInTransaction>[1]) =>
		t.store
			.read((db) => t.plans.listInTransaction(db, query))
			.map((p) => p.text);
	expect(texts()).toEqual([
		"soon plan",
		"other conv",
		"late plan",
		"undated new",
		"undated old",
	]);
	expect(texts({ conversationId: "c1", limit: 2 })).toEqual([
		"soon plan",
		"late plan",
	]);
	expect(texts({ kinds: ["intent"] })).toEqual(["undated new"]);
	await t.done();
});

test("overdue plans wait for confirmation, and a touch opens them again", async () => {
	const t = setup();
	const add = (text: string, dueAt: string | null) =>
		t.store.write((db) =>
			t.plans.addInTransaction(db, {
				conversationId: "c1",
				kind: "plan",
				text,
				dueAt,
				evidence: say(`m-${text}`),
			}),
		);
	const day = await add("day plan", "2026-11-22");
	const hour = await add("hour plan", "2026-11-22T10:30");
	await add("future plan", "2026-11-24T18:00");
	await add("undated plan", null);
	const mark = (localNow: string) =>
		t.store.write((db) => t.plans.markDueAwaitingInTransaction(db, localNow));
	// A date alone is not over during its own day; a date with a time is over after that minute.
	expect(await mark("2026-11-22T10:30")).toEqual([]);
	expect(await mark("2026-11-22T10:31")).toEqual([hour.id]);
	expect(await mark("2026-11-23T00:00")).toEqual([day.id]);
	expect(await mark("2026-11-24T18:00")).toEqual([]);
	expect(await mark("2026-11-23T00:00")).toEqual([]);
	await expect(mark("2026-11-23")).rejects.toThrow("invalid_plan_due");
	const waiting = t.store.read((db) =>
		t.plans.listInTransaction(db, { states: ["awaiting_confirmation"] }),
	);
	expect(waiting.map((p) => p.id)).toEqual([day.id, hour.id]);
	expect(waiting[0]?.revision).toBe(2);
	// Awaiting plans are in the default list (still open items), and a new date opens one again.
	expect(t.store.read((db) => t.plans.listInTransaction(db))).toHaveLength(4);
	const reopened = await t.store.write((db) =>
		t.plans.updateInTransaction(db, day.id, {
			dueAt: "2026-11-30",
			evidence: say("m9"),
		}),
	);
	expect(reopened).toMatchObject({ state: "open", dueAt: "2026-11-30" });
	await t.done();
});

test("a date with a zone is stored in local time (JST), so the overdue comparison agrees with it", async () => {
	const t = setup();
	const add = (text: string, dueAt: string | null) =>
		t.store.write((db) =>
			t.plans.addInTransaction(db, {
				conversationId: "c1",
				kind: "plan",
				text,
				dueAt,
				evidence: say(`m-${text}`),
			}),
		);
	const utc = await add("utc", "2026-11-22T01:00Z");
	const plus = await add("plus", "2026-11-22T10:30:15+09:00");
	const west = await add("west", "2026-11-21T20:00-05:00");
	const local = await add("local", "2026-11-22T10:30");
	const day = await add("day", "2026-11-22");
	expect([utc, plus, west, local, day].map((plan) => plan.dueAt)).toEqual([
		"2026-11-22T10:00",
		"2026-11-22T10:30:15",
		"2026-11-22T10:00",
		"2026-11-22T10:30",
		"2026-11-22",
	]);
	const mark = (localNow: string) =>
		t.store.write((db) => t.plans.markDueAwaitingInTransaction(db, localNow));
	// 01:00Z is 10:00 in Tokyo: not over at 10:00, over at 10:01 (together with -05:00 20:00 = 10:00 JST).
	expect(await mark("2026-11-22T10:00")).toEqual([]);
	expect((await mark("2026-11-22T10:01")).sort()).toEqual(
		[utc.id, west.id].sort(),
	);
	// An update converts the same way.
	const moved = await t.store.write((db) =>
		t.plans.updateInTransaction(db, plus.id, {
			dueAt: "2026-11-23T00:00Z",
			evidence: say("m9"),
		}),
	);
	expect(moved?.dueAt).toBe("2026-11-23T09:00");
	await t.done();
});

test("a conversation holds 30 open plans and all together 200; closing frees a place", async () => {
	const t = setup();
	const add = (conversationId: string, i: number) =>
		t.store.write((db) =>
			t.plans.addInTransaction(db, {
				conversationId,
				kind: "intent",
				text: `intent ${i}`,
				evidence: say(`m${i}`),
			}),
		);
	const first = await add("c1", 0);
	for (let i = 1; i < 30; i++) await add("c1", i);
	await expect(add("c1", 30)).rejects.toThrow("invalid_plan_limit");
	await add("c2", 100);
	await t.store.write((db) =>
		t.plans.closeInTransaction(db, first.id, { evidence: say("mx") }),
	);
	await add("c1", 31);
	for (let c = 3; c <= 8; c++)
		for (let i = 0; i < (c === 8 ? 19 : 30); i++) await add(`c${c}`, i);
	// 30 + 1 + 150 + 19 = 200: the 200th open plan is the last.
	await expect(add("c9", 0)).rejects.toThrow("invalid_plan_limit");
	expect(t.store.read((db) => t.plans.listInTransaction(db)).length).toBe(200);
	await t.done();
});

test("full-text search finds related plans, short words too, and leaves closed ones out", async () => {
	const t = setup();
	const add = (text: string, conversationId = "c1") =>
		t.store.write((db) =>
			t.plans.addInTransaction(db, {
				conversationId,
				kind: "plan",
				text,
				evidence: say(`m-${text}`),
			}),
		);
	const dentist = await add("水曜に歯医者の予約がある");
	await add("週末に京都へ旅行する");
	await add("歯医者の後に買い物", "c2");
	const found = (text: string, query?: { conversationId?: string }) =>
		t.store
			.read((db) => t.plans.searchInTransaction(db, text, query))
			.map((p) => p.text);
	expect(found("歯医者の予約").sort()).toEqual(
		["水曜に歯医者の予約がある", "歯医者の後に買い物"].sort(),
	);
	expect(found("歯医者の予約")[0]).toBe("水曜に歯医者の予約がある");
	expect(found("歯医者", { conversationId: "c2" })).toEqual([
		"歯医者の後に買い物",
	]);
	expect(found("京都")).toEqual(["週末に京都へ旅行する"]);
	expect(found("存在しない話題")).toEqual([]);
	expect(found("  ")).toEqual([]);
	// The index follows a rewrite and a close.
	await t.store.write((db) =>
		t.plans.updateInTransaction(db, dentist.id, {
			text: "木曜に美容院",
			evidence: say("m9"),
		}),
	);
	expect(found("歯医者の予約")).toEqual(["歯医者の後に買い物"]);
	expect(found("美容院")).toEqual(["木曜に美容院"]);
	await t.store.write((db) =>
		t.plans.closeInTransaction(db, dentist.id, { evidence: say("m10") }),
	);
	expect(found("美容院")).toEqual([]);
	expect(
		t.store
			.read((db) =>
				t.plans.searchInTransaction(db, "美容院", { states: ["closed"] }),
			)
			.map((p) => p.text),
	).toEqual(["木曜に美容院"]);
	await t.done();
});

test("closed plans are pruned after the retention time", async () => {
	const t = setup();
	const plan = await t.store.write((db) =>
		t.plans.addInTransaction(db, {
			conversationId: "c1",
			kind: "plan",
			text: "済んだ予定",
			evidence: say("m1"),
		}),
	);
	await t.store.write((db) =>
		t.plans.closeInTransaction(db, plan.id, { evidence: say("m2") }),
	);
	t.now.at = "2026-12-20T09:00:00.000Z";
	expect(
		await t.store.write((db) => t.plans.pruneClosedInTransaction(db)),
	).toBe(0);
	t.now.at = "2026-12-23T09:00:00.000Z";
	expect(
		await t.store.write((db) => t.plans.pruneClosedInTransaction(db)),
	).toBe(1);
	expect(
		t.store.read((db) => t.plans.getInTransaction(db, plan.id)),
	).toBeNull();
	expect(
		t.store.read((db) =>
			db.query("SELECT COUNT(*) AS n FROM continuity_evidence").get(),
		),
	).toEqual({ n: 0 });
	await t.done();
});

test("the question ledger records, changes and lists what was asked", async () => {
	const t = setup();
	const asked = await t.store.write((db) =>
		t.questions.recordInTransaction(db, {
			conversationId: "c1",
			attribute: "コーヒーの飲み方",
			state: "asked",
			evidence: say("agent1"),
		}),
	);
	expect(asked).toMatchObject({
		state: "asked",
		askedAt: "2026-11-22T09:00:00.000Z",
		revision: 1,
	});
	t.now.at = "2026-11-22T09:05:00.000Z";
	// The same attribute in another wording is the same entry.
	const answered = await t.store.write((db) =>
		t.questions.recordInTransaction(db, {
			conversationId: "c2",
			attribute: " コーヒーの 飲み方 ",
			state: "answered",
			evidence: { messages: [{ messageId: "m5", quote: "ブラック派" }] },
		}),
	);
	expect(answered).toMatchObject({
		id: asked.id,
		state: "answered",
		revision: 2,
		askedAt: "2026-11-22T09:00:00.000Z",
		updatedAt: "2026-11-22T09:05:00.000Z",
		conversationId: "c1",
	});
	expect(answered.evidence.map((e) => e.messageId)).toEqual(["agent1", "m5"]);
	t.now.at = "2026-11-22T09:10:00.000Z";
	const other = await t.store.write((db) =>
		t.questions.recordInTransaction(db, {
			conversationId: "c1",
			attribute: "好きな色",
			state: "deferred",
			evidence: say("m6"),
		}),
	);
	expect(other.askedAt).toBeNull();
	expect(
		t.store
			.read((db) => t.questions.listInTransaction(db))
			.map((q) => q.attribute),
	).toEqual(["好きな色", "コーヒーの飲み方"]);
	expect(
		t.store
			.read((db) =>
				t.questions.listInTransaction(db, { states: ["answered", "declined"] }),
			)
			.map((q) => q.attribute),
	).toEqual(["コーヒーの飲み方"]);
	expect(
		t.store.read((db) => t.questions.findInTransaction(db, "好きな　色"))?.id,
	).toBe(other.id);
	const declined = await t.store.write((db) =>
		t.questions.updateStateInTransaction(db, other.id, {
			state: "declined",
			evidence: say("m7"),
			expectedRevision: 1,
		}),
	);
	expect(declined).toMatchObject({ state: "declined", revision: 2 });
	expect(
		await t.store.write((db) =>
			t.questions.updateStateInTransaction(db, other.id, {
				state: "answered",
				evidence: say("m8"),
				expectedRevision: 1,
			}),
		),
	).toBeNull();
	await expect(
		t.store.write((db) =>
			t.questions.recordInTransaction(db, {
				conversationId: "c1",
				attribute: "x",
				state: "asked",
				evidence: { messages: [] },
			}),
		),
	).rejects.toThrow("invalid_continuity_evidence");
	await t.done();
});

test("entries resting on an excluded source are not listed, searched or found", async () => {
	const t = setup();
	await t.store.write((db) => {
		t.plans.addInTransaction(db, {
			conversationId: "c1",
			kind: "plan",
			text: "元カノの誕生日",
			evidence: say("m-ex"),
		});
		t.plans.addInTransaction(db, {
			conversationId: "c1",
			kind: "plan",
			text: "元カノの話の続き",
			evidence: say("m-ok", "m-other"),
		});
		t.plans.addInTransaction(db, {
			conversationId: "c1",
			kind: "plan",
			text: "記憶から派生した予定",
			evidence: { messages: [], memoryItemIds: ["item-ex"] },
		});
		t.questions.recordInTransaction(db, {
			conversationId: "c1",
			attribute: "元カノ",
			state: "asked",
			evidence: say("m-ex"),
		});
	});
	const all = () => ({
		plans: t.store
			.read((db) => t.plans.listInTransaction(db))
			.map((p) => p.text),
		found: t.store
			.read((db) => t.plans.searchInTransaction(db, "元カノの"))
			.map((p) => p.text),
		questions: t.store.read((db) => t.questions.listInTransaction(db)).length,
	});
	expect(all().plans).toHaveLength(3);
	t.service.setEvidenceExclusion((_db, sources) => ({
		messageIds: new Set(sources.messageIds.filter((id) => id === "m-ex")),
		memoryItemIds: new Set(
			sources.memoryItemIds.filter((id) => id === "item-ex"),
		),
	}));
	expect(all()).toEqual({
		plans: ["元カノの話の続き"],
		found: ["元カノの話の続き"],
		questions: 0,
	});
	expect(
		t.store.read((db) => t.questions.findInTransaction(db, "元カノ")),
	).toBeNull();
	// The rows are still there: only the closure delete removes them.
	expect(
		t.store.read((db) =>
			db.query("SELECT COUNT(*) AS n FROM continuity_plans").get(),
		),
	).toEqual({ n: 3 });
	await t.done();
});

test("forgetting a message or a memory item deletes what rests on it, index and evidence too", async () => {
	const t = setup();
	const ids = await t.store.write((db) => ({
		byMessage: t.plans.addInTransaction(db, {
			conversationId: "c1",
			kind: "plan",
			text: "忘れる予定",
			evidence: say("m1", "m2"),
		}).id,
		kept: t.plans.addInTransaction(db, {
			conversationId: "c1",
			kind: "plan",
			text: "残る予定",
			evidence: say("m3"),
		}).id,
		byItem: t.plans.addInTransaction(db, {
			conversationId: "c1",
			kind: "decision",
			text: "記憶由来の決定",
			evidence: { messages: [{ messageId: "m4" }], memoryItemIds: ["i1"] },
		}).id,
		question: t.questions.recordInTransaction(db, {
			conversationId: "c1",
			attribute: "忘れる質問",
			state: "answered",
			evidence: say("m2"),
		}).id,
		keptQuestion: t.questions.recordInTransaction(db, {
			conversationId: "c1",
			attribute: "残る質問",
			state: "answered",
			evidence: say("m3"),
		}).id,
	}));
	const result = await t.store.write((db) =>
		t.service.deleteDerivedBySourcesInTransaction(db, {
			messageIds: ["m2", "none"],
			memoryItemIds: ["i1"],
		}),
	);
	expect(new Set(result.planIds)).toEqual(new Set([ids.byMessage, ids.byItem]));
	expect(result.questionIds).toEqual([ids.question]);
	expect(
		t.store.read((db) => t.plans.listInTransaction(db)).map((p) => p.id),
	).toEqual([ids.kept]);
	expect(
		t.store.read((db) => t.questions.listInTransaction(db)).map((q) => q.id),
	).toEqual([ids.keptQuestion]);
	expect(
		t.store
			.read((db) => t.plans.searchInTransaction(db, "忘れる予定"))
			.map((p) => p.id),
	).toEqual([ids.kept]);
	// No trace of the forgotten text or sources is left in any table.
	const left = t.store.read((db) => ({
		evidence: db
			.query("SELECT source_id AS id FROM continuity_evidence ORDER BY id")
			.all(),
		search: db.query("SELECT COUNT(*) AS n FROM continuity_plan_search").get(),
	}));
	expect(left).toEqual({
		evidence: [{ id: "m3" }, { id: "m3" }],
		search: { n: 1 },
	});
	// A second run finds nothing.
	expect(
		await t.store.write((db) =>
			t.service.deleteDerivedBySourcesInTransaction(db, {
				messageIds: ["m2"],
				memoryItemIds: ["i1"],
			}),
		),
	).toEqual({ planIds: [], questionIds: [] });
	await t.done();
});

test("migration: open goals, decisions and open questions move to L3; memos, closed and expired notes do not", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-plans-migration-"));
	const file = join(dir, "db.sqlite3");
	try {
		const before = openStore(
			file,
			migrations.filter(
				(m) =>
					m.id !== "continuity/0008-plans" &&
					m.id !== "continuity/0009-short-term-to-plans" &&
					m.id !== "continuity/0010-drop-short-term",
			),
		);
		await before.write((db) => {
			const insert = db.query(
				`INSERT INTO continuity_items (id, conversation_id, kind, text, status, revision, created_at, updated_at, origin, expires_at)
				 VALUES (?,?,?,?,?,?,?,?,?,?)`,
			);
			const row = (
				id: string,
				kind: string,
				status = "active",
				expiresAt: string | null = null,
				conversation = "c1",
			) =>
				insert.run(
					id,
					conversation,
					kind,
					`text of ${id}`,
					status,
					3,
					"2026-11-01T00:00:00.000Z",
					"2026-11-10T00:00:00.000Z",
					"agent",
					expiresAt,
				);
			row("goal1", "goal");
			row("decision1", "decision", "active", null, "c2");
			row("question1", "open_question");
			row("memo1", "memo", "active", "2999-01-01T00:00:00.000Z");
			row("activity1", "activity");
			row("resolved1", "goal", "resolved");
			row("retracted1", "decision", "retracted");
			row("expired1", "open_question", "active", "2020-01-01T00:00:00.000Z");
			db.query(
				"INSERT INTO continuity_item_source (item_id, message_id) VALUES ('goal1','m1'),('goal1','m2'),('memo1','m3'),('decision1','m4')",
			).run();
		});
		await before.close();
		// Without the drop (0010): the old notes are still there to be counted below.
		const after = openStore(
			file,
			migrations.filter((m) => m.id !== "continuity/0010-drop-short-term"),
		);
		const service = createContinuityService();
		const moved = after.read((db) =>
			service.plans.listInTransaction(db, {
				states: ["open", "awaiting_confirmation", "closed"],
			}),
		);
		expect(
			moved
				.map((p) => ({
					id: p.id,
					conversationId: p.conversationId,
					kind: p.kind,
					text: p.text,
					state: p.state,
					dueAt: p.dueAt,
					messages: p.evidence.map((e) => e.messageId),
				}))
				.sort((a, b) => a.id.localeCompare(b.id)),
		).toEqual([
			{
				id: "decision1",
				conversationId: "c2",
				kind: "decision",
				text: "text of decision1",
				state: "open",
				dueAt: null,
				messages: ["m4"],
			},
			{
				id: "goal1",
				conversationId: "c1",
				kind: "intent",
				text: "text of goal1",
				state: "open",
				dueAt: null,
				messages: ["m1", "m2"],
			},
			{
				id: "question1",
				conversationId: "c1",
				kind: "open_question",
				text: "text of question1",
				state: "open",
				dueAt: null,
				messages: [],
			},
		]);
		expect(moved.find((p) => p.id === "goal1")).toMatchObject({
			createdAt: "2026-11-01T00:00:00.000Z",
			lastTouchedAt: "2026-11-10T00:00:00.000Z",
			revision: 1,
		});
		// Search and forgetting work on the moved rows; the old notes are untouched by them.
		expect(
			after
				.read((db) => service.plans.searchInTransaction(db, "text of goal1"))
				.map((p) => p.id)[0],
		).toBe("goal1");
		expect(
			await after.write((db) =>
				service.deleteDerivedBySourcesInTransaction(db, {
					messageIds: ["m2"],
					memoryItemIds: [],
				}),
			),
		).toEqual({ planIds: ["goal1"], questionIds: [] });
		expect(
			after.read((db) =>
				db.query("SELECT COUNT(*) AS n FROM continuity_items").get(),
			),
		).toEqual({ n: 8 });
		await after.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("continuity/0010 drops the old short-term tables and leaves the plans, the ledger and the event flow", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-plans-0010-"));
	const file = join(dir, "db.sqlite3");
	try {
		const before = openStore(
			file,
			migrations.filter((m) => m.id !== "continuity/0010-drop-short-term"),
		);
		await before.write((db) => {
			db.query(
				`INSERT INTO continuity_items (id, conversation_id, kind, text, status, revision, created_at, updated_at, origin)
				 VALUES ('g1','c1','goal','移行する','active',1,'2026-11-01T00:00:00.000Z','2026-11-01T00:00:00.000Z','agent')`,
			).run();
		});
		await before.close();
		const after = openStore(file, [...migrations]);
		try {
			const tables = after
				.read((db) =>
					db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all(),
				)
				.map((row) => (row as { name: string }).name);
			for (const gone of [
				"continuity_items",
				"continuity_item_source",
				"continuity_revisions",
			])
				expect(tables).not.toContain(gone);
			for (const kept of [
				"continuity_plans",
				"continuity_questions",
				"continuity_evidence",
			])
				expect(tables).toContain(kept);
		} finally {
			await after.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
