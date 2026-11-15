import { expect, test } from "bun:test";
import { agendaFixture } from "./always-on.fixture";
import { referencedInput, staleMemoryRefs } from "./input";
import { saveItem } from "../../domains/memory/test/memory.fixture";

test("a memory the agenda cites that was superseded is stale for the agenda exactly when a reply citing it is refused", async () => {
	const f = await agendaFixture();
	try {
		await f.user(
			"source-a",
			"ao",
			"朝はコーヒー、のちに紅茶を飲むようになった",
		);
		const first = await saveItem(f.h.store, f.h.memory!, {
			conversationId: "ao",
			messageId: "source-a",
			kind: "preference",
			semanticKey: "drink",
			text: "朝はコーヒーを飲む",
		});
		const ref = `memory:${first.id}`;
		const check = () =>
			f.h.store.read((db) => ({
				stale: staleMemoryRefs(f.deps, db, [ref, "source-a", "note:n1"]),
				reply: referencedInput(f.deps, db, [], [ref]).complete,
			}));
		expect(check()).toEqual({ stale: [], reply: true });
		await saveItem(f.h.store, f.h.memory!, {
			conversationId: "ao",
			messageId: "source-a",
			kind: "preference",
			semanticKey: "drink",
			text: "朝は紅茶を飲む",
		});
		expect(
			f.h.memory!.list().find((item) => item.id === first.id)?.status,
		).not.toBe("active");
		expect(check()).toEqual({ stale: [ref], reply: false });
	} finally {
		await f.close();
	}
});
