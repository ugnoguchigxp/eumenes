import { expect, test } from "bun:test";
import { harness, searchBind } from "./route-harness";
test("new research never prefetches a legacy host lookup or imports cached candidates before requirements freeze", async () => {
	const h = await harness();
	try {
		h.proposals.push({
			kind: "search-first",
			proposalToken: "old",
			query: "legacy keyword",
			language: "ja",
			region: "JP",
		});
		h.binds.set("old", searchBind());
		await h.start("new");
		const child = h.agents.list("new").find((t) => t.kind === "worker")!;
		expect(h.started).toHaveLength(0);
		expect(h.task(child.id).tool_calls).toBe(0);
		expect(h.task(child.id).package_revision_id).toBe("package:web.quick@1");
		await h.runRawModelStep(child.id, {
			action: "invoke",
			tool: "web.lookup",
			arguments: { query: "first" },
		});
		expect(h.started).toHaveLength(0);
		expect(h.task(child.id).json_repairs).toBe(1);
	} finally {
		await h.close();
	}
});
