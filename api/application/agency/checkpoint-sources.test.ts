import { expect, test } from "bun:test";
import { continuityHost } from "./continuity.fixture";
import { updated } from "./host.fixture";
import { saveItem } from "../../domains/memory/test/memory.fixture";

for (const operation of ["independent scope save", "close"] as const) {
	test(`a changed Memory version in an inactive scope does not block ${operation}`, async () => {
		const h = await continuityHost(() => updated());
		try {
			await h.exchange();
			const item = await saveItem(h.store, h.memory, {
				conversationId: "c1",
				messageId: "u1",
				kind: "preference",
				semanticKey: "sky",
				text: "雲の形を眺めるのが好き",
			});
			await h.advance(61_000);
			await h.host.attend("other");
			const refs = h.store.read((db) =>
				h.memory.referenceInputs.captureInTransaction(db, {
					itemIds: [item.id],
				}),
			);
			expect(
				h.host
					.inspect("c1")
					?.snapshot.provenance?.entries.some(([, input]) =>
						input.sources.some((s) => refs.sources.includes(s)),
					),
			).toBe(true);
			const changed = await h.store.write((db) =>
				h.memory.applyCurationInTransaction(db, {
					conversationId: "c1",
					items: [
						{
							op: "update",
							itemId: item.id,
							revision: item.revision,
							text: "雲の色の変化を眺めるのが好き",
							messageId: "u1",
							explicit: true,
						},
					],
				}),
			);
			expect(changed[0]?.status).toBe("applied");
			const stale = h.store.read((db) =>
				h.memory.referenceInputs.staleInTransaction(db, refs.sources),
			);
			expect(stale.length).toBeGreaterThan(0);
			if (operation === "close") await h.host.close();
			else {
				await h.host.attend("fresh");
				expect(h.host.status("fresh").tracked).toBe(true);
				expect(h.host.inspect("c1")?.snapshot.forgottenRefs).toEqual(
					expect.arrayContaining(stale),
				);
				expect(
					h.host.inspect("other")?.snapshot.forgottenRefs ?? [],
				).not.toEqual(expect.arrayContaining(stale));
			}
			expect(() =>
				h.store.read((db) => h.state.recordsInTransaction(db)),
			).not.toThrow();
		} finally {
			// A failed baseline still releases the temporary store through the normal review path.
			await h.advance(61_000);
			await h.close();
		}
	});
}
