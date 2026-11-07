import { expect, test } from "bun:test";
import { harness, updated } from "./host.fixture";
import { settle } from "../../infrastructure/wait-for";

test("a burst within the presented observation window reaches selection in the same opportunity", async () => {
	const h = harness({ update: () => updated() });
	await h.store.write((db) => {
		for (let n = 0; n < 6; n++) {
			h.conversation.appendInTransaction(
				db,
				h.message("c1", `u${n}`, "user", `会話の材料 ${n}`),
			);
			h.conversation.appendInTransaction(
				db,
				h.message("c1", `a${n}`, "assistant", `返答 ${n}`, `run-${n}`),
			);
		}
	});
	await settle();
	expect(h.host.inspect("c1")?.snapshot.cursor).toBe(12);
	expect(h.calls.update).toBe(1);
	expect(h.calls.select).toBe(1);
});
