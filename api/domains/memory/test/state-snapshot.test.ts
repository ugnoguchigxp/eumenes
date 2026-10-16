import { afterEach, expect, test } from "bun:test";
import { listState } from "eumenes-memory/sqlite";
import { PRINCIPAL, PROFILE_SCOPE } from "../contracts";
import { listAllState } from "../service/state-snapshot";
import { setupMemory, type MemoryHarness } from "./memory.fixture";
const open: MemoryHarness[] = [];
afterEach(async () => {
	for (const h of open.splice(0)) await h.close();
});

test("all-page reads preserve history and tied-sequence order under the authorized scope", async () => {
	const h = await setupMemory();
	open.push(h);
	for (let i = 0; i < 7; i++) await h.seed(`好み${i}`, `test.${i}`);
	const first = h.memory.list()[0]!;
	const messageId = await h.say("user", "訂正した好み");
	await h.curate([
		{
			op: "update",
			itemId: first.id,
			revision: first.revision,
			text: "訂正した好み",
			messageId,
		},
	]);
	await h.store.write((db) =>
		db.exec("UPDATE memory_state_item SET updated_seq = 1"),
	);
	const input = {
		contractVersion: 1 as const,
		scopeKey: PROFILE_SCOPE,
		access: {
			principal: PRINCIPAL,
			scopeKeys: [PROFILE_SCOPE],
			purpose: "test",
			policyRevision: "1",
		},
		includeInactive: true,
		limit: 2,
	};
	h.store.read((db) => {
		const page = listState(db, input);
		expect(page.status).toBe("ok");
		if (page.status !== "ok") throw new Error("blocked");
		expect(page.items).toHaveLength(2);
		expect(page.nextCursor).toBeDefined();
		const all = listAllState(db, input);
		expect(all.status).toBe("ok");
		if (all.status !== "ok") throw new Error("blocked");
		expect(all.items).toHaveLength(8);
		expect(all.items.map((i) => i.itemId)).toEqual(
			all.items.map((i) => i.itemId).sort(),
		);
		expect(new Set(all.items.map((i) => i.itemId)).size).toBe(8);
		expect(
			listAllState(db, { ...input, access: { ...input.access, scopeKeys: [] } })
				.status,
		).toBe("blocked");
	});
});
