import { expect, test } from "bun:test";
import { collectorHarness, eventsPage, NOW } from "./larm.fixture";
import { emptyLarm } from "../contracts/larm";
test("checkpoint rollback cannot consume a cursor, and source changes cannot leak previous history", async () => {
	const h = collectorHarness(),
		state = emptyLarm(NOW);
	state.cursor = "must-not-commit";
	await expect(
		h.repository.save("source", state, eventsPage().events, () => {
			throw new Error("cancelled");
		}),
	).rejects.toThrow();
	expect(h.repository.read("source").cursor).toBeNull();
	expect(h.repository.events("source")).toHaveLength(0);
	await h.repository.save("source", state, eventsPage().events, () => {});
	expect(h.repository.read("source").cursor).toBe("must-not-commit");
	await h.repository.save("other", emptyLarm(NOW), [], () => {});
	expect(h.repository.events("source")).toHaveLength(0);
	expect(h.repository.read("other").snapshot).toBeUndefined();
});
test("local history enforces the upstream count and byte bounds and records pruned ranges", async () => {
	const h = collectorHarness(),
		e = eventsPage().events[1]!;
	await h.store.write((db) => {
		db.query(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<100001)
INSERT INTO monitoring_larm_events SELECT 'source','event:'||i,?,1,json_set(?,'$.id','event:'||i,'$.sequence',cast(i AS TEXT)) FROM n`).run(
			NOW - 1,
			JSON.stringify(e),
		);
	});
	await h.repository.save("source", emptyLarm(NOW), [], () => {});
	expect(
		h.store.read(
			(db) =>
				(
					db
						.query("SELECT count(*) AS n FROM monitoring_larm_events")
						.get() as { n: number }
				).n,
		),
	).toBe(100000);
	expect(h.repository.read("source").localPrunedBefore).toBe(NOW - 1);
	await h.store.write((db) => {
		db.query("DELETE FROM monitoring_larm_events").run();
		const insert = db.query(
			"INSERT INTO monitoring_larm_events VALUES('source',?,?,?,?)",
		);
		insert.run("a", NOW - 2, 40000000, JSON.stringify(e));
		insert.run("b", NOW - 1, 40000000, JSON.stringify(e));
	});
	await h.repository.save("source", emptyLarm(NOW), [], () => {});
	expect(
		h.store.read(
			(db) =>
				(
					db
						.query("SELECT count(*) AS n FROM monitoring_larm_events")
						.get() as { n: number }
				).n,
		),
	).toBe(1);
	h.advance(600001);
	await h.repository.save("source", h.repository.read("source"), [], () => {});
	expect(h.repository.events("source")).toHaveLength(0);
});
