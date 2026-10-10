import { expect, test } from "bun:test";
import { harness, directBind, learnedPackage } from "./route-harness";
test("a cached legacy route never replaces the model-selected new worker package", async () => {
	const h = await harness();
	try {
		h.proposals.push({
			kind: "direct",
			proposalToken: "old",
			packageRevisionId: learnedPackage,
		});
		h.binds.set("old", directBind());
		await h.start("new");
		const child = h.agents.list("new").find((t) => t.kind === "worker")!;
		expect(child.packageRevisionId).toBe("package:web.quick@1");
		expect(h.started).toHaveLength(0);
		expect(h.proposals).toHaveLength(1);
	} finally {
		await h.close();
	}
});
