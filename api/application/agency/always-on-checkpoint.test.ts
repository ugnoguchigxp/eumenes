import { expect, test } from "bun:test";
import { agendaFixture, promiseResearch, replyWith } from "./always-on.fixture";
import { createAgendaScope } from "./always-on-scope";
import { createAgendaCheckpoints } from "./always-on-checkpoint";
import { marksFor } from "./always-on-recall";
import { recoverAgendaScope } from "./always-on-recovery";
import { settle } from "../../infrastructure/wait-for";
import { isAgendaSnapshot } from "../../domains/dialogue";
import { saveItem } from "../../domains/memory/test/memory.fixture";

test("a queued checkpoint rejects a changed capture and saves all latest scopes with the feed", async () => {
	const f = await agendaFixture();
	const gate = Promise.withResolvers<void>();
	const deps = {
		...f.deps,
		store: {
			...f.deps.store,
			write: async <T>(
				operation: Parameters<typeof f.deps.store.write<T>>[0],
			) => {
				await gate.promise;
				return f.deps.store.write(operation);
			},
		},
	};
	const c = createAgendaScope({
		deps,
		id: "ao",
		epoch: 0,
		now: Date.now,
		text: () => null,
		kick: () => {},
	});
	const convs = new Map([[c.id, c]]);
	let cursor = 1,
		savedCursor = 0;
	const checkpoints = createAgendaCheckpoints({
		deps,
		convs,
		now: Date.now,
		hostDigest: "fixture",
		invalidate: () => {},
		feed: () => ({ cursor, activeId: "ao" }),
		persisted: new Map(),
		saved(_rows, value) {
			savedCursor = value;
		},
	});
	const observe = (id: string) => {
		c.agent.observe({ id, who: "user", text: `fixture ${id}`, at: Date.now() });
		c.revision++;
	};
	try {
		await f.user("a");
		observe("a");
		const old = checkpoints.save();
		await f.user("b");
		observe("b");
		cursor = 2;
		gate.resolve();
		expect(await old).toBe(false);
		expect(savedCursor).toBe(0);
		expect(await checkpoints.save()).toBe(true);
		const records = f.h.store.read((db) => f.port.recordsInTransaction(db));
		expect(records).toHaveLength(1);
		expect(isAgendaSnapshot(records[0]!.snapshot)).toBe(true);
		expect(f.h.store.read((db) => f.port.feedInTransaction(db))).toEqual({
			cursor: 2,
			activeId: "ao",
		});
		expect(savedCursor).toBe(2);
	} finally {
		gate.resolve();
		await f.close();
	}
});

test("recovery isolates an unknown snapshot and revokes an old always-on record while another conversation remains", async () => {
	const f = await agendaFixture();
	try {
		await f.start();
		await f.user("a");
		await f.user("b", "b");
		await f.host.attend("b");
		await settle();
		await f.host.close();
		await f.h.store.write((db) => {
			db.query(
				"UPDATE dialogue_agency_state SET snapshot_json=? WHERE conversation_id='ao'",
			).run(JSON.stringify({ kind: "always-on", version: 999 }));
		});
		await f.restart();
		expect(f.host.inspect("ao")).toBeNull();
		expect(f.host.inspect("b")).not.toBeNull();
		await expect(f.host.attend("ao")).resolves.toMatchObject({ tracked: true });
	} finally {
		await f.close();
	}
});

test("a checkpoint keeps the open promises and the quiet across a restart, and not the words", async () => {
	const f = await agendaFixture();
	try {
		await f.start();
		await f.user("user-a");
		// The reply promises a research and asks for a pause of everything: the research stays queued.
		const { seen } = await replyWith(f, promiseResearch);
		expect(seen).toHaveLength(2);
		await f.host.attend("ao");
		await settle();
		const before = f.host.inspect("ao")!.snapshot.agent;
		expect(before.items.map((i) => i.text)).toEqual([
			"fixture promised research",
		]);
		expect(before.quiet.allUntil).not.toBeNull();
		await f.restart();
		const after = f.host.inspect("ao")!.snapshot.agent;
		expect(after.items.map((i) => [i.text, i.requested, i.promised])).toEqual([
			["fixture promised research", true, true],
		]);
		expect(after.quiet.allUntil).toBe(before.quiet.allUntil);
		const saved = f.h.store.read((db) =>
			db
				.query(
					"SELECT snapshot_json FROM dialogue_agency_state WHERE conversation_id='ao'",
				)
				.get(),
		) as { snapshot_json: string };
		expect(saved.snapshot_json).not.toContain("fixture user-a");
		// Nothing runs while the pause lasts: no plan, no research.
		await f.advance();
		// (The records writer reads the words that were not read before the restart: it is no plan or research.)
		expect(f.requests.filter((_, i) => f.kinds[i] !== "records")).toHaveLength(
			0,
		);
		expect(f.h.toolchain.agents.executions.list("ao")).toHaveLength(0);
	} finally {
		await f.close();
	}
});

test("forgetting a message forgets the items that rest on it, running and saved", async () => {
	const f = await agendaFixture();
	try {
		await f.start();
		await f.user("user-a");
		await f.user("user-b");
		await replyWith(f, promiseResearch);
		await f.host.attend("ao");
		await settle();
		const items = () => f.host.inspect("ao")!.snapshot.agent.items;
		// The request rests on the user's latest words (user-b); user-a is another line.
		expect(items()).toHaveLength(1);
		await f.h.memory!.forget({
			conversationId: "ao",
			messageIds: ["user-a"],
			itemIds: [],
		});
		expect(items()).toHaveLength(1);
		await f.h.memory!.forget({
			conversationId: "ao",
			messageIds: ["user-b"],
			itemIds: [],
		});
		expect(items()).toHaveLength(0);
		expect(f.host.inspect("ao")!.snapshot.agent.quiet.allUntil).not.toBeNull();
		await f.restart();
		expect(f.host.inspect("ao")!.snapshot.agent.items).toHaveLength(0);
	} finally {
		await f.close();
	}
});

test("forgetting reaches a saved record no agent holds", async () => {
	const f = await agendaFixture();
	try {
		await f.start();
		await f.user("user-a");
		await replyWith(f, promiseResearch);
		await f.host.attend("ao");
		await settle();
		await f.host.close();
		// A purge while the host is down: the saved record is rewritten.
		await f.h.store.write((db) =>
			f.port.forgetInTransaction(db, { messageIds: ["user-a"], itemIds: [] }),
		);
		await f.restart();
		expect(f.host.inspect("ao")!.snapshot.agent.items).toHaveLength(0);
	} finally {
		await f.close();
	}
});

test("superseded memory is removed from live agenda items before the next reply", async () => {
	let memoryRef: string;
	const f = await agendaFixture({
		script(kind) {
			if (kind !== "plan") return undefined;
			return {
				add: [
					{
						kind: "talk",
						text: "fixture topic",
						refs: ["source", memoryRef],
						value: 5,
						reason: "fixture",
						topic: "fixture",
					},
				],
				drop: [],
				focus: "fixture",
			};
		},
	});
	try {
		await f.user("source", "ao", "I used to prefer pencil and now prefer pen.");
		const write = (value: string) =>
			saveItem(f.h.store, f.h.memory!, {
				conversationId: "ao",
				messageId: "source",
				kind: "preference",
				semanticKey: "writing-instrument",
				text: value,
			});
		memoryRef = `memory:${(await write("Prefers pencil")).id}`;
		const c = createAgendaScope({
			deps: f.deps,
			id: "ao",
			epoch: 0,
			now: () => f.now,
			text: () => null,
			kick: () => {},
		});
		c.agent.observe({ id: "source", who: "user", text: "fixture", at: f.now });
		await c.agent.step(
			f.now + 15_000,
			() => ({ busy: false }),
			new AbortController().signal,
		);
		expect(c.agent.view().items.map((item) => item.refs)).toEqual([
			["source", memoryRef],
		]);
		expect(c.agent.snapshot(f.now).items).toEqual([]);

		await write("Prefers pen");
		const checkpoints = createAgendaCheckpoints({
			deps: f.deps,
			convs: new Map([[c.id, c]]),
			now: () => f.now,
			hostDigest: "fixture",
			invalidate: () => {},
			feed: () => ({ cursor: 0, activeId: null }),
			persisted: new Map(),
			saved: () => {},
		});
		await checkpoints.refresh(c);
		// A corrected record is not forgotten: what rests on it is held, under review, until the agent lets it go.
		expect(c.agent.view().items.map((item) => item.refs)).toEqual([
			["source", memoryRef],
		]);
		expect(marksFor(f.deps, c).underReview).toContain(memoryRef);
	} finally {
		await f.close();
	}
});

/** Two scopes of one store, a checkpoint over them, and counters of what the checkpoint wrote and read. */
async function twoScopes() {
	const f = await agendaFixture();
	const counts = { saved: [] as string[], feeds: 0, reads: 0 };
	const state = {
		...f.deps.state,
		saveInTransaction: (
			...args: Parameters<typeof f.deps.state.saveInTransaction>
		) => {
			counts.saved.push(args[1].conversationId);
			return f.deps.state.saveInTransaction(...args);
		},
		saveFeedInTransaction: (
			...args: Parameters<typeof f.deps.state.saveFeedInTransaction>
		) => {
			counts.feeds++;
			return f.deps.state.saveFeedInTransaction(...args);
		},
	};
	const deps = {
		...f.deps,
		state,
		store: {
			...f.deps.store,
			read: <T>(operation: Parameters<typeof f.deps.store.read<T>>[0]) => {
				counts.reads++;
				return f.deps.store.read(operation);
			},
		},
	};
	const scope = (id: string) =>
		createAgendaScope({
			deps,
			id,
			epoch: 0,
			now: Date.now,
			text: () => null,
			kick: () => {},
		});
	const a = scope("a"),
		b = scope("b");
	const convs = new Map([
		[a.id, a],
		[b.id, b],
	]);
	const persisted = new Map<string, number>();
	let cursor = 1;
	const checkpoints = createAgendaCheckpoints({
		deps,
		convs,
		now: Date.now,
		hostDigest: "fixture",
		invalidate: () => {},
		feed: () => ({ cursor, activeId: null }),
		persisted,
		saved(rows) {
			for (const row of rows) persisted.set(row.id, row.revision);
		},
	});
	const reset = () => {
		counts.saved = [];
		counts.feeds = 0;
		counts.reads = 0;
	};
	return {
		f,
		a,
		b,
		convs,
		persisted,
		counts,
		checkpoints,
		reset,
		setCursor: (value: number) => (cursor = value),
	};
}

test("a checkpoint writes only the scopes whose revision differs from the saved one, and the feed alone when none does", async () => {
	const t = await twoScopes();
	try {
		expect(await t.checkpoints.save()).toBe(true);
		expect(t.counts.saved.sort()).toEqual(["a", "b"]);
		expect(t.persisted.get("a")).toBe(t.a.revision);
		t.reset();
		// One scope changes: the other is not written.
		t.a.revision++;
		expect(await t.checkpoints.save()).toBe(true);
		expect(t.counts.saved).toEqual(["a"]);
		expect(t.counts.feeds).toBe(1);
		expect(t.persisted.get("a")).toBe(t.a.revision);
		t.reset();
		// Only the feed moved: no scope is written, the feed is.
		t.setCursor(5);
		expect(await t.checkpoints.save()).toBe(true);
		expect(t.counts.saved).toEqual([]);
		expect(t.counts.feeds).toBe(1);
		expect(t.f.h.store.read((db) => t.f.port.feedInTransaction(db))).toEqual({
			cursor: 5,
			activeId: null,
		});
		// Nothing was lost by skipping: both records hold what the scopes hold.
		const records = t.f.h.store.read((db) => t.f.port.recordsInTransaction(db));
		expect(records.map((r) => r.conversationId).sort()).toEqual(["a", "b"]);
	} finally {
		await t.f.close();
	}
});

test("a checkpoint called from the pump reuses the refresh before it, and any other call refreshes every scope", async () => {
	const t = await twoScopes();
	try {
		await t.checkpoints.save();
		t.reset();
		await t.checkpoints.save();
		// One read of the stale sources per scope, none in the transaction.
		expect(t.counts.reads).toBe(2);
		t.reset();
		await t.checkpoints.save({ refreshed: true });
		expect(t.counts.reads).toBe(0);
	} finally {
		await t.f.close();
	}
});

test("a scope whose epoch moved is still refused when it is not the dirty one", async () => {
	const t = await twoScopes();
	try {
		await t.checkpoints.save();
		t.a.revision++;
		t.reset();
		// The record of b is revoked (its epoch moves) while the scope b holds the old one.
		await t.f.h.store.write((db) => t.f.port.revokeInTransaction(db, "b"));
		expect(await t.checkpoints.save({ refreshed: true })).toBe(false);
		expect(t.counts.saved).toEqual([]);
		expect(t.persisted.get("a")).not.toBe(t.a.revision);
	} finally {
		await t.f.close();
	}
});

test("forgetting in one scope writes that scope back and no other, and the saved record no longer holds it", async () => {
	const t = await twoScopes();
	try {
		for (const c of [t.a, t.b]) {
			c.agent.observe({ id: `${c.id}-1`, who: "user", text: "x", at: 1 });
			c.revision++;
		}
		await t.checkpoints.save();
		t.reset();
		t.checkpoints.forgetRefs(t.a, ["a-1"]);
		expect(await t.checkpoints.save()).toBe(true);
		expect(t.counts.saved).toEqual(["a"]);
		expect(t.persisted.get("a")).toBe(t.a.revision);
		expect(t.persisted.get("b")).toBe(t.b.revision);
	} finally {
		await t.f.close();
	}
});

test("an epoch change and a recovery that drop a ticket make the scope dirty, so the next checkpoint writes it back", async () => {
	const t = await twoScopes();
	try {
		await t.checkpoints.save();
		// A recovery finds the ticket's work gone: the ticket is dropped and the scope is written.
		t.a.tickets = [
			{
				id: "t1",
				itemId: "i1",
				agentTicketId: "t1",
				revisionId: "r",
				question: "q",
				at: 1,
				refs: [],
				inputs: [],
			},
		];
		t.persisted.set("a", t.a.revision);
		recoverAgendaScope(t.f.deps, t.a, Date.now());
		expect(t.a.tickets).toHaveLength(0);
		t.reset();
		expect(await t.checkpoints.save()).toBe(true);
		expect(t.counts.saved).toEqual(["a"]);
		// A purge reaches a scope that cites the words: it is invalidated (its revision moves) and written back.
		t.b.agent.observe({ id: "b-1", who: "user", text: "x", at: 1 });
		t.b.revision++;
		await t.checkpoints.save();
		const invalidated: string[] = [];
		const invalidating = createAgendaCheckpoints({
			deps: t.f.deps,
			convs: t.convs,
			now: Date.now,
			hostDigest: "fixture",
			invalidate: (c) => {
				invalidated.push(c.id);
				c.revision++;
			},
			feed: () => ({ cursor: 1, activeId: null }),
			persisted: t.persisted,
			saved: () => {},
		});
		const before = t.persisted.get("b");
		await t.f.h.store.write((db) =>
			invalidating.forgetInTransaction(db, {
				messageIds: ["b-1"],
				itemIds: [],
			}),
		);
		// Only the scope that cites the words is invalidated; its revision now differs from the saved one.
		expect(invalidated).toEqual(["b"]);
		expect(t.b.revision).not.toBe(before);
		t.reset();
		expect(await t.checkpoints.save()).toBe(true);
		expect(t.counts.saved).toEqual(["b"]);
		expect(t.persisted.get("b")).toBe(t.b.revision);
	} finally {
		await t.f.close();
	}
});

test("a write unrelated to the conversation makes the host pump without writing a checkpoint", async () => {
	const f = await agendaFixture();
	try {
		await f.start();
		await f.user("user-a");
		await settle();
		let saves = 0,
			feeds = 0;
		const save = f.deps.state.saveInTransaction;
		const saveFeed = f.deps.state.saveFeedInTransaction;
		f.deps.state.saveInTransaction = (...args) => {
			saves++;
			return save(...args);
		};
		f.deps.state.saveFeedInTransaction = (...args) => {
			feeds++;
			return saveFeed(...args);
		};
		for (let i = 0; i < 3; i++) {
			await f.h.store.write((db) => {
				db.exec("CREATE TABLE IF NOT EXISTS unrelated_probe(x)");
				db.query("INSERT INTO unrelated_probe(x) VALUES(?)").run(i);
			});
			await settle();
		}
		expect(saves).toBe(0);
		expect(feeds).toBe(0);
	} finally {
		await f.close();
	}
});
