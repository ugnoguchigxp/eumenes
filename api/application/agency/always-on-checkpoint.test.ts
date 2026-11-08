import { expect, test } from "bun:test";
import { alwaysOnFixture } from "./always-on.fixture";
import { createAlwaysOnScope } from "./always-on-scope";
import { createAlwaysOnCheckpoints } from "./always-on-checkpoint";
import { observationInput } from "./input";
import { settle } from "../../infrastructure/wait-for";

test("a queued checkpoint rejects a changed capture and saves all latest scopes with the feed", async () => {
	const f = await alwaysOnFixture();
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
	const c = createAlwaysOnScope({
		deps,
		id: "ao",
		epoch: 0,
		now: Date.now,
		run: async () => null,
		settled: async () => {},
	});
	const convs = new Map([[c.id, c]]);
	let cursor = 1,
		savedCursor = 0;
	const checkpoints = createAlwaysOnCheckpoints({
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
		c.agent.observe(
			{
				id,
				actor: "user",
				kind: "exchange.adopted",
				occurredAt: Date.now(),
				text: `fixture ${id}`,
			},
			f.h.store.read((db) => observationInput(f.deps, db, id)),
		);
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
		expect(f.h.store.read((db) => f.port.feedInTransaction(db))).toEqual({
			cursor: 2,
			activeId: "ao",
		});
		expect(savedCursor).toBe(2);
	} finally {
		gate.resolve();
		c.scheduler.dispose();
		await f.close();
	}
});

for (const failure of ["unknown-version", "missing-record"] as const) {
	test(`recovery isolates ${failure} while another conversation remains available`, async () => {
		const f = await alwaysOnFixture();
		try {
			await f.start();
			await f.user("a");
			await f.user("b", "b");
			await f.host.attend("b");
			await settle();
			await f.host.close();
			await f.h.store.write((db) => {
				if (failure === "unknown-version")
					db.query(
						"UPDATE dialogue_agency_state SET snapshot_json=? WHERE conversation_id='ao'",
					).run(JSON.stringify({ kind: "always-on", version: 999 }));
				else {
					const row = f.port
						.observationsInTransaction(db, "ao")
						.find((r) => r.observationId === "a")!;
					f.port.deleteObservationInTransaction(db, row);
				}
			});
			await f.restart();
			expect(f.host.inspect("ao")).toBeNull();
			expect(
				f.host
					.inspect("b")!
					.snapshot.agent.observations.some((o) => o.id === "b"),
			).toBe(true);
			await expect(f.host.attend("ao")).resolves.toMatchObject({
				tracked: true,
			});
		} finally {
			await f.close();
		}
	});
}

test("incomplete host input cannot reach the think provider even before any forgetting", async () => {
	const f = await alwaysOnFixture();
	const c = createAlwaysOnScope({
		deps: f.deps,
		id: "ao",
		epoch: 0,
		now: Date.now,
		run: async () => null,
		settled: async () => {},
	});
	try {
		c.agent.observe(
			{
				id: "untracked",
				actor: "host",
				kind: "source.changed",
				occurredAt: Date.now(),
				text: "fixture untracked source",
			},
			{ sources: [], complete: false },
		);
		await c.agent.tick(
			Date.now(),
			() => ({ busy: false }),
			new AbortController().signal,
		);
		expect(f.requests).toHaveLength(0);
		expect(c.agent.view().thoughts).toHaveLength(0);
	} finally {
		c.scheduler.dispose();
		await f.close();
	}
});
