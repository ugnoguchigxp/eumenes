import { expect, test } from "bun:test";
import { harness } from "./toolchain.fixture";
import { taskAutonomy } from "./task-autonomy";
import type { TaskExecutionHost } from "./task-execution-port";

test("automatic task registration requires real cancellation and erasure operations", async () => {
	const h = await harness({ everyday: true });
	try {
		const entry = h.store.read((db) =>
			h.routing
				.catalogInTransaction(db)
				.find((e) => e.runtime.execution === "task"),
		)!;
		expect(entry).toBeDefined();
		const owner = h.store.read((db) =>
			h.routing.taskInTransaction!(db, entry.revisionId),
		)!;
		for (const missing of [
			"cancelInTransaction",
			"forgetInTransaction",
			null,
		] as const) {
			const policy = taskAutonomy(
				{
					routing: {
						...h.routing,
						taskInTransaction: () => ({
							...owner,
							...(missing ? { [missing]: undefined } : {}),
						}),
					},
					registry: h.toolchain.registry,
				} as unknown as TaskExecutionHost,
				{ available: () => [] },
			);
			expect(h.store.read((db) => policy(db, entry.revisionId))).toMatchObject(
				missing
					? { automatic: false, reason: "lifecycle_unavailable" }
					: { automatic: true, reason: "available" },
			);
		}
	} finally {
		await h.close();
	}
});
