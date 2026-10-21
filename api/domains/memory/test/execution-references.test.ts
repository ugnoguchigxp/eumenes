import { expect, test } from "bun:test";
import { setupMemory } from "./memory.fixture";

test("delegated Memory is an issued item reference; unrelated additions and a rebuilt window leave it valid", async () => {
	const h = await setupMemory();
	try {
		const item = await h.seed("短い動画が好み", "video-length");
		const window = await h.window();
		const refs = await h.store.write((db) =>
			h.memory.executionReferencesInTransaction(db, window),
		);
		const ref = refs.find((r) => r.id === item.id)!;
		expect(ref).toBeDefined();
		const read = () =>
			h.store.read((db) => h.memory.executionReferenceInTransaction(db, ref));
		expect(read()).toContain("短い動画が好み");
		await h.seed("散歩が好き", "walking");
		await h.window();
		expect(read()).toContain("短い動画が好み");
		await h.stop(item.id, item.revision);
		expect(read()).toBeNull();
	} finally {
		await h.close();
	}
});
test("forgetting immediately erases issued reference bodies and rejects forged refs", async () => {
	const h = await setupMemory();
	try {
		const item = await h.seed("静かな音楽が好み", "music");
		const window = await h.window();
		const [ref] = await h.store.write((db) =>
			h.memory.executionReferencesInTransaction(db, window),
		);
		expect(ref).toBeDefined();
		expect(
			h.store.read((db) =>
				h.memory.executionReferenceInTransaction(db, {
					...ref!,
					digest: "forged",
				}),
			),
		).toBeNull();
		await h.forget([item.id]);
		expect(
			h.store.read((db) => h.memory.executionReferenceInTransaction(db, ref!)),
		).toBeNull();
		expect(
			h.store.read((db) =>
				db
					.query(
						"SELECT COUNT(*) AS n FROM memory_execution_refs WHERE item_id=?",
					)
					.get(item.id),
			),
		).toEqual({ n: 0 });
	} finally {
		await h.close();
	}
});
