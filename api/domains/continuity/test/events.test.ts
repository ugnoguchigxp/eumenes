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

test("forgetting a message purges the events that showed it", async () => {
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
		});
		const changed = await store.write((db) =>
			events.forgetMessagesInTransaction(db, ["m1"], at(9)),
		);
		expect(changed).toEqual(["c1"]);
		const [event] = store.read((db) => events.logInTransaction(db, "c1"));
		expect(event!.forgotten).toBe(true);
		expect(event!.text).not.toContain("東京都");
		expect(event!.text).toContain('"forgotten":true');
	} finally {
		done();
	}
});

test("a corrected message rewrites the said events that showed it and keeps the rest", async () => {
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

test("a delivery is read by its utterance, and what came after a seq is read without the whole log", async () => {
	const { store, events, done } = setup();
	try {
		const said = await store.write((db) => {
			const { event } = events.appendInTransaction(db, {
				conversationId: "c1",
				at: at(1),
				type: "said",
				by: "agent",
				fields: { text: "作りますね" },
				deliveryKey: "run:r1",
			});
			return event;
		});
		expect(
			store.read((db) => events.heardInTransaction(db, "c1", said.id)),
		).toBeNull();
		await store.write((db) =>
			events.appendInTransaction(db, {
				conversationId: "c1",
				at: at(2),
				type: "delivered",
				by: "host",
				fields: { ref: said.id, heard: "partial" },
				dedupeKey: `delivered:${said.id}`,
			}),
		);
		store.read((db) => {
			expect(events.heardInTransaction(db, "c1", said.id)).toBe("partial");
			expect(events.latestSeqInTransaction(db, "c1")).toBe(2);
			expect(events.latestSeqInTransaction(db, "other")).toBe(0);
			expect(
				events.loggedAfterInTransaction(db, "c1", 1).map((e) => e.type),
			).toEqual(["delivered"]);
		});
	} finally {
		done();
	}
});
