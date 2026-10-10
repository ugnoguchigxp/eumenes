import { expect, test } from "bun:test";
import { harness } from "./route-harness";
test("new research has no legacy route-replacement lookup after an unavailable proposal", async () => {
	const h = await harness();
	try {
		h.proposals.push({ kind: "unavailable", code: "route_disabled" });
		await h.start("new");
		const child = h.agents.list("new").find((t) => t.kind === "worker")!;
		expect(child.status).toBe("queued");
		expect(h.started).toHaveLength(0);
		expect(h.proposals).toHaveLength(1);
		await h.store.write((db) =>
			h.agents.cancelTreeInTransaction(db, "new", "cancelled"),
		);
		expect(h.started).toHaveLength(0);
	} finally {
		await h.close();
	}
});
