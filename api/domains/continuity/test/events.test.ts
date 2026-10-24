import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import {
	createContinuityService,
	eventsMigration,
	itemSourceMigration,
	migration,
	shortTermMigration,
} from "..";

function setup() {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-events-"));
	const store = openStore(join(dir, "db.sqlite3"), [
		migration,
		shortTermMigration,
		itemSourceMigration,
		eventsMigration,
	]);
	const events = createContinuityService(store).events;
	return { store, events, done: () => rmSync(dir, { recursive: true }) };
}

const at = (second: number) =>
	`2026-10-24T10:00:${String(second).padStart(2, "0")}+09:00`;

test("events are numbered, rendered once and frozen; Japanese stays readable and < > & are escaped", async () => {
	const { store, events, done } = setup();
	try {
		const { event } = await store.write((db) =>
			events.appendInTransaction(db, {
				conversationId: "c1",
				at: at(1),
				type: "said",
				by: "agent",
				fields: { origin: "reply", text: "箱根です <b>&" },
			}),
		);
		expect(event.id).toBe("e1");
		expect(event.status).toBe("logged");
		expect(event.text).toBe(
			'{"id":"e1","at":"2026-10-24T10:00:01+09:00","type":"said","by":"agent","origin":"reply","text":"箱根です \\u003cb\\u003e\\u0026"}',
		);
		expect(event.tokens).toBeGreaterThan(0);
		// Reading it again gives the same bytes.
		expect(store.read((db) => events.logInTransaction(db, "c1"))[0]!.text).toBe(
			event.text,
		);
	} finally {
		done();
	}
});

test("a pending utterance stays out of the log until handled, then is appended after what the log holds", async () => {
	const { store, events, done } = setup();
	try {
		await store.write((db) => {
			events.appendInTransaction(db, {
				conversationId: "c1",
				at: at(1),
				type: "said",
				by: "user",
				fields: { text: "宿を調べて" },
				messageIds: ["m1"],
				pending: true,
			});
			events.appendInTransaction(db, {
				conversationId: "c1",
				at: at(2),
				type: "said",
				by: "agent",
				fields: { origin: "spontaneous", text: "紅葉の季節ですね" },
			});
		});
		expect(
			store.read((db) => events.pendingInTransaction(db, "c1")),
		).toHaveLength(1);
		expect(
			store.read((db) => events.logInTransaction(db, "c1")).map((e) => e.id),
		).toEqual(["e2"]);
		await store.write((db) => events.handleInTransaction(db, "c1", [1]));
		const log = store.read((db) => events.logInTransaction(db, "c1"));
		// Appended in the order of appending; `at` keeps the real time.
		expect(log.map((e) => e.id)).toEqual(["e2", "e1"]);
		expect(log[1]!.at).toBe(at(1));
		expect(store.read((db) => events.pendingInTransaction(db, "c1"))).toEqual(
			[],
		);
		// Handling twice changes nothing.
		expect(
			await store.write((db) => events.handleInTransaction(db, "c1", [1])),
		).toEqual([]);
	} finally {
		done();
	}
});

test("only a user utterance can be pending", async () => {
	const { store, events, done } = setup();
	try {
		expect(
			store.write((db) =>
				events.appendInTransaction(db, {
					conversationId: "c1",
					at: at(1),
					type: "acted",
					by: "agent",
					fields: {},
					pending: true,
				}),
			),
		).rejects.toThrow("invalid_pending_event");
	} finally {
		done();
	}
});

test("the same dedupe key is one event: a repeated action is carried out once", async () => {
	const { store, events, done } = setup();
	try {
		const first = await store.write((db) =>
			events.appendInTransaction(db, {
				conversationId: "c1",
				at: at(1),
				type: "acted",
				by: "agent",
				fields: { action: "delegate", todo: "w1" },
				dedupeKey: "e1:delegate:web.research",
			}),
		);
		const again = await store.write((db) =>
			events.appendInTransaction(db, {
				conversationId: "c1",
				at: at(2),
				type: "acted",
				by: "agent",
				fields: { action: "delegate", todo: "w2" },
				dedupeKey: "e1:delegate:web.research",
			}),
		);
		expect(first.created).toBe(true);
		expect(again.created).toBe(false);
		expect(again.event.seq).toBe(first.event.seq);
		expect(store.read((db) => events.logInTransaction(db, "c1"))).toHaveLength(
			1,
		);
	} finally {
		done();
	}
});

test("moving out drops the frozen text; the short form is used only where one exists", async () => {
	const { store, events, done } = setup();
	try {
		await store.write((db) => {
			events.appendInTransaction(db, {
				conversationId: "c1",
				at: at(1),
				type: "acted",
				by: "agent",
				fields: { action: "memory_read", query: "好み", result: ["長い本文"] },
				shortFields: { action: "memory_read", query: "好み", result: ["st_1"] },
			});
			events.appendInTransaction(db, {
				conversationId: "c1",
				at: at(2),
				type: "said",
				by: "user",
				fields: { text: "ありがとう" },
			});
			events.shortenInTransaction(db, "c1", [1, 2]);
		});
		const [read, said] = store.read((db) => events.logInTransaction(db, "c1"));
		expect(read!.form).toBe("short");
		expect(read!.text).toContain('"st_1"');
		expect(said!.form).toBe("full");
		await store.write((db) => events.moveOutInTransaction(db, "c1", [1]));
		expect(
			store.read((db) => events.logInTransaction(db, "c1")).map((e) => e.id),
		).toEqual(["e2"]);
		const moved = store.read((db) => events.movedInTransaction(db, "c1"));
		expect(moved[0]!.text).toBeNull();
	} finally {
		done();
	}
});

test("forgetting a message purges the events that showed it and turns standing summaries into unsummarized ranges", async () => {
	const { store, events, done } = setup();
	try {
		await store.write((db) => {
			events.appendInTransaction(db, {
				conversationId: "c1",
				at: at(1),
				type: "said",
				by: "user",
				fields: { text: "住所は東京都…" },
				messageIds: ["m1"],
			});
			events.writeEpisodeInTransaction(db, "c1", "shown", [
				{
					kind: "summary",
					fromSeq: 1,
					toSeq: 1,
					fromAt: at(1),
					toAt: at(1),
					count: 1,
					text: "住所を話した",
					messageIds: ["m1"],
				},
				{
					kind: "summary",
					fromSeq: 2,
					toSeq: 3,
					fromAt: at(2),
					toAt: at(3),
					count: 2,
					text: "天気の話",
					messageIds: ["m2"],
				},
			]);
		});
		const changed = await store.write((db) =>
			events.forgetMessagesInTransaction(db, ["m1"], at(9)),
		);
		expect(changed).toEqual(["c1"]);
		const [event] = store.read((db) => events.logInTransaction(db, "c1"));
		expect(event!.forgotten).toBe(true);
		expect(event!.text).not.toContain("東京都");
		expect(event!.text).toContain('"forgotten":true');
		const episode = store.read((db) => events.episodeInTransaction(db, "c1"));
		expect(episode[0]).toMatchObject({ kind: "unsummarized", text: "" });
		expect(episode[1]).toMatchObject({ kind: "summary", text: "天気の話" });
		expect(
			store.read((db) => events.windowVersionInTransaction(db, "c1")).version,
		).toBe(1);
	} finally {
		done();
	}
});

test("a corrected message rewrites the said events that showed it, keeps the rest, and unsummarizes summaries on it", async () => {
	const { store, events, done } = setup();
	try {
		await store.write((db) => {
			events.appendInTransaction(db, {
				conversationId: "c1",
				at: at(1),
				type: "said",
				by: "user",
				fields: { text: "集合は9時", to: "specialist" },
				messageIds: ["m1"],
			});
			events.appendInTransaction(db, {
				conversationId: "c1",
				at: at(2),
				type: "acted",
				by: "agent",
				fields: { action: "delegate", request: "9時の集合を確認" },
				messageIds: ["m1"],
			});
			events.writeEpisodeInTransaction(db, "c1", "shown", [
				{
					kind: "summary",
					fromSeq: 1,
					toSeq: 1,
					fromAt: at(1),
					toAt: at(1),
					count: 1,
					text: "9時に集合",
					messageIds: ["m1"],
				},
			]);
		});
		const changed = await store.write((db) =>
			events.correctMessageInTransaction(db, "m1", "集合は10時", at(9)),
		);
		expect(changed).toEqual(["c1"]);
		const [said, acted] = store.read((db) => events.logInTransaction(db, "c1"));
		expect(JSON.parse(said!.text!)).toEqual({
			id: "e1",
			at: at(1),
			type: "said",
			by: "user",
			text: "集合は10時",
			to: "specialist",
		});
		// Only what the message said is its text; the agent's own record of its action stays as it was.
		expect(acted!.text).toContain("9時の集合を確認");
		expect(
			store.read((db) => events.episodeInTransaction(db, "c1"))[0],
		).toMatchObject({ kind: "unsummarized", text: "" });
		expect(
			store.read((db) => events.windowVersionInTransaction(db, "c1")),
		).toMatchObject({ version: 1, reason: "correct" });
	} finally {
		done();
	}
});

test("a TODO's work result is overwritten in place and removed on archive", async () => {
	const { store, events, done } = setup();
	try {
		await store.write((db) => {
			events.putActiveInTransaction(db, {
				conversationId: "c1",
				todoId: "w1",
				status: "waiting",
				at: at(1),
				fields: { question: "日付は？" },
			});
			events.putActiveInTransaction(db, {
				conversationId: "c1",
				todoId: "w2",
				status: "done",
				at: at(2),
				fields: {},
			});
			events.putActiveInTransaction(db, {
				conversationId: "c1",
				todoId: "w1",
				status: "done",
				at: at(3),
				fields: { result: { claims: [] } },
			});
		});
		const slots = store.read((db) => events.activeInTransaction(db, "c1"));
		expect(slots.map((slot) => slot.todoId)).toEqual(["w1", "w2"]);
		expect(slots[0]!.text).toContain('"status":"done"');
		expect(slots[0]!.text).not.toContain("日付");
		expect(
			await store.write((db) =>
				events.removeActiveInTransaction(db, "c1", "w1"),
			),
		).toBe(true);
		expect(
			store
				.read((db) => events.activeInTransaction(db, "c1"))
				.map((s) => s.todoId),
		).toEqual(["w2"]);
	} finally {
		done();
	}
});

test("curation reads handled events only and marks them", async () => {
	const { store, events, done } = setup();
	try {
		await store.write((db) => {
			events.appendInTransaction(db, {
				conversationId: "c1",
				at: at(1),
				type: "said",
				by: "user",
				fields: { text: "a" },
				pending: true,
			});
			events.appendInTransaction(db, {
				conversationId: "c1",
				at: at(2),
				type: "said",
				by: "agent",
				fields: { text: "b" },
			});
		});
		expect(
			store
				.read((db) => events.uncuratedInTransaction(db, "c1"))
				.map((e) => e.id),
		).toEqual(["e2"]);
		expect(
			store.read((db) => events.conversationsWithUncuratedInTransaction(db)),
		).toEqual(["c1"]);
		await store.write((db) => events.markCuratedInTransaction(db, "c1", [2]));
		expect(store.read((db) => events.uncuratedInTransaction(db, "c1"))).toEqual(
			[],
		);
	} finally {
		done();
	}
});

const LIMITS = {
	log: { cap: 400, high: 300, low: 150, keep: 80 },
	episode: 400,
	active: 200,
	silenceMs: 120_000,
};

async function said(
	store: ReturnType<typeof setup>["store"],
	events: ReturnType<typeof setup>["events"],
	at: string,
	text: string,
	messageId: string,
) {
	await store.write((db) =>
		events.appendInTransaction(db, {
			conversationId: "c1",
			at,
			type: "said",
			by: "user",
			fields: { text },
			messageIds: [messageId],
		}),
	);
}

const minute = (m: number, s = 0) =>
	`2026-10-24T10:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}+09:00`;

test("re-construction moves the oldest events at a break in the talk, down to the low target", async () => {
	const { store, events, done } = setup();
	try {
		// Two bursts with a five-minute silence between them, about 50 tokens each.
		for (let i = 0; i < 6; i++)
			await said(store, events, minute(0, i * 10), "あ".repeat(30), `m${i}`);
		for (let i = 0; i < 2; i++)
			await said(store, events, minute(5, i * 10), "い".repeat(30), `n${i}`);
		const before = store.read((db) => events.logInTransaction(db, "c1"));
		const total = before.reduce((sum, e) => sum + e.tokens, 0);
		expect(total).toBeGreaterThan(LIMITS.log.high);
		const result = await store.write((db) =>
			events.reconstructInTransaction(db, {
				conversationId: "c1",
				at: minute(9),
				reason: "log_over_target",
				limits: LIMITS,
			}),
		);
		// The smallest fitting cut would split the first burst; the cut is at the silence instead.
		expect(result.moved).toBe(6);
		const log = store.read((db) => events.logInTransaction(db, "c1"));
		expect(log.map((e) => e.id)).toEqual(["e7", "e8"]);
		const episode = store.read((db) => events.episodeInTransaction(db, "c1"));
		expect(episode).toEqual([
			expect.objectContaining({
				kind: "unsummarized",
				fromSeq: 1,
				toSeq: 6,
				count: 6,
			}),
		]);
		expect(result.version).toBe(1);
	} finally {
		done();
	}
});

test("a prepared summary covering the moved range replaces the unsummarized mark, and a later one fills an earlier mark", async () => {
	const { store, events, done } = setup();
	try {
		for (let i = 0; i < 10; i++)
			await said(store, events, minute(i), "う".repeat(30), `m${i}`);
		await store.write((db) =>
			events.writeEpisodeInTransaction(db, "c1", "prepared", [
				{
					kind: "summary",
					fromSeq: 1,
					toSeq: 3,
					fromAt: minute(0),
					toAt: minute(2),
					count: 3,
					text: "最初の話",
					messageIds: ["m0", "m1", "m2"],
				},
			]),
		);
		await store.write((db) =>
			events.reconstructInTransaction(db, {
				conversationId: "c1",
				at: minute(20),
				reason: "log_over_target",
				limits: LIMITS,
			}),
		);
		const episode = store.read((db) => events.episodeInTransaction(db, "c1"));
		expect(episode[0]).toMatchObject({ kind: "summary", text: "最初の話" });
		expect(episode[1]).toMatchObject({ kind: "unsummarized", fromSeq: 4 });
		const unsummarizedTo = episode[1]!.toSeq;
		// The steward prepares the rest later: the next re-construction fills the mark.
		await store.write((db) =>
			events.writeEpisodeInTransaction(db, "c1", "prepared", [
				{
					kind: "summary",
					fromSeq: 4,
					toSeq: unsummarizedTo,
					fromAt: minute(3),
					toAt: minute(unsummarizedTo - 1),
					count: unsummarizedTo - 3,
					text: "続きの話",
					messageIds: [],
				},
			]),
		);
		await store.write((db) =>
			events.reconstructInTransaction(db, {
				conversationId: "c1",
				at: minute(21),
				reason: "cache_lost",
				limits: LIMITS,
			}),
		);
		const filled = store.read((db) => events.episodeInTransaction(db, "c1"));
		expect(filled.map((s) => s.kind)).toEqual(["summary", "summary"]);
		expect(filled[1]!.text).toBe("続きの話");
	} finally {
		done();
	}
});

test("resuming keeps only the last `keep` tokens", async () => {
	const { store, events, done } = setup();
	try {
		for (let i = 0; i < 6; i++)
			await said(store, events, minute(i), "え".repeat(30), `m${i}`);
		await store.write((db) =>
			events.reconstructInTransaction(db, {
				conversationId: "c1",
				at: minute(59),
				reason: "resumed",
				limits: LIMITS,
			}),
		);
		const log = store.read((db) => events.logInTransaction(db, "c1"));
		expect(log.reduce((sum, e) => sum + e.tokens, 0)).toBeLessThanOrEqual(
			LIMITS.log.keep,
		);
		expect(log.length).toBeGreaterThan(0);
	} finally {
		done();
	}
});

test("a full episode stays inside its limit without any model: summaries become marks, marks merge, the oldest is absorbed", async () => {
	const { store, events, done } = setup();
	try {
		const segments = Array.from({ length: 8 }, (_, i) => ({
			kind: (i % 2 === 0 ? "summary" : "unsummarized") as
				| "summary"
				| "unsummarized",
			fromSeq: i * 10 + 1,
			toSeq: i * 10 + 10,
			fromAt: minute(i),
			toAt: minute(i, 30),
			count: 10,
			text: i % 2 === 0 ? "長い要約".repeat(20) : "",
			messageIds: [],
		}));
		await store.write((db) =>
			events.writeEpisodeInTransaction(db, "c1", "shown", segments),
		);
		for (let i = 0; i < 10; i++)
			await said(store, events, minute(30, i), "お".repeat(30), `m${i}`);
		const result = await store.write((db) =>
			events.reconstructInTransaction(db, {
				conversationId: "c1",
				at: minute(40),
				reason: "section_over_limit",
				limits: { ...LIMITS, episode: 120 },
			}),
		);
		expect(result.episodeTokens).toBeLessThanOrEqual(120);
		const episode = store.read((db) => events.episodeInTransaction(db, "c1"));
		// Still a continuous record from the first event.
		expect(episode[0]!.fromSeq).toBe(1);
	} finally {
		done();
	}
});

test("older memory reads switch to their short form; finished work results go first when over the limit", async () => {
	const { store, events, done } = setup();
	try {
		await store.write((db) => {
			events.appendInTransaction(db, {
				conversationId: "c1",
				at: minute(0),
				type: "acted",
				by: "agent",
				fields: { action: "memory_read", result: ["か".repeat(60)] },
				shortFields: { action: "memory_read", result: ["st_1"] },
			});
			events.appendInTransaction(db, {
				conversationId: "c1",
				at: minute(1),
				type: "said",
				by: "user",
				fields: { text: "き".repeat(90) },
			});
			for (const [todoId, status] of [
				["w1", "done"],
				["w2", "waiting"],
				["w3", "done"],
			] as const)
				events.putActiveInTransaction(db, {
					conversationId: "c1",
					todoId,
					status,
					at: minute(2),
					fields: { result: "く".repeat(80) },
				});
		});
		const result = await store.write((db) =>
			events.reconstructInTransaction(db, {
				conversationId: "c1",
				at: minute(3),
				reason: "section_over_limit",
				limits: LIMITS,
			}),
		);
		expect(result.shortened).toBe(1);
		expect(store.read((db) => events.logInTransaction(db, "c1"))[0]!.form).toBe(
			"short",
		);
		// Over the 200-token limit: the oldest finished one goes; the waiting one stays.
		expect(result.removedActive).toEqual(["w1"]);
	} finally {
		done();
	}
});

test("a prepared summary spanning consecutive shown parts replaces them (merging summaries)", async () => {
	const { store, events, done } = setup();
	try {
		const part = (from: number, to: number, text: string) => ({
			kind: "summary" as const,
			fromSeq: from,
			toSeq: to,
			fromAt: minute(from),
			toAt: minute(to),
			count: to - from + 1,
			text,
			messageIds: [],
		});
		await store.write((db) => {
			events.writeEpisodeInTransaction(db, "c1", "shown", [
				part(1, 5, "前半"),
				part(6, 10, "後半"),
				part(11, 12, "最近"),
			]);
			events.writeEpisodeInTransaction(db, "c1", "prepared", [
				part(1, 10, "前半と後半"),
			]);
		});
		await store.write((db) =>
			events.reconstructInTransaction(db, {
				conversationId: "c1",
				at: minute(30),
				reason: "section_over_limit",
				limits: LIMITS,
			}),
		);
		const episode = store.read((db) => events.episodeInTransaction(db, "c1"));
		expect(episode.map((s) => s.text)).toEqual(["前半と後半", "最近"]);
		expect(
			store.read((db) => events.episodeInTransaction(db, "c1", "prepared")),
		).toEqual([]);
	} finally {
		done();
	}
});
