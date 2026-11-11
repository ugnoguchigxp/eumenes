import { expect, test } from "bun:test";
import { agendaFixture, promiseResearch, replyWith } from "./always-on.fixture";
import { createAgendaScope } from "./always-on-scope";
import { createAgendaCheckpoints } from "./always-on-checkpoint";
import { settle } from "../../infrastructure/wait-for";
import { isAgendaSnapshot } from "../../domains/dialogue";

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
		expect(f.requests).toHaveLength(0);
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
