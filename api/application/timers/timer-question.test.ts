import { expect, test } from "bun:test";
import { createToolchainRouting } from "../toolchain/toolchain-routing";
import { harness } from "../toolchain/toolchain.fixture";

const TARGET = "builtin:timerTargetAnswer";

async function start(
	h: Awaited<ReturnType<typeof harness>>,
	durationSeconds: number,
	label?: string,
) {
	return h.timers!.start({
		requestId: crypto.randomUUID(),
		issuedAt: new Date().toISOString(),
		durationSeconds,
		...(label ? { label } : {}),
	});
}

test("the timer adapter issues its timers as the choices of a target question, and nothing for other schemas", async () => {
	const h = await harness({ timers: true });
	try {
		const adapter = h.toolchain.registry.get("adapter:timers@1")!;
		expect(
			h.store.read((db) => adapter.choicesInTransaction!(db, TARGET)),
		).toEqual([]);
		const tea = await start(h, 180, "お茶");
		await start(h, 60);
		const choices = h.store.read((db) =>
			adapter.choicesInTransaction!(db, TARGET),
		);
		expect(choices).toHaveLength(2);
		const first = choices.find(
			(c) => c.ref === (tea.receipt as { timer: { id: string } }).timer.id,
		)!;
		expect(first.label).toMatch(/^お茶（残り\d+秒・動作中）$/);
		expect(
			choices.every((c) => c.ref.length <= 64 && c.label.length <= 120),
		).toBe(true);
		expect(
			h.store.read((db) =>
				adapter.choicesInTransaction!(db, "builtin:answerText"),
			),
		).toEqual([]);
		// Dialogue reaches them only through the bound port, by binding.
		const routing = createToolchainRouting(
			h.toolchain.capabilities,
			h.toolchain.history,
			async () => undefined,
			h.toolchain.registry,
			h.toolchain.schemas,
		);
		expect(
			h.store.read((db) =>
				routing.bound!.questionChoicesInTransaction(
					db,
					"binding:timers.command@4",
					TARGET,
				),
			),
		).toEqual(choices);
	} finally {
		await h.close();
	}
});

test("a choice list is capped at 20 timers", async () => {
	const h = await harness({ timers: true });
	try {
		for (let i = 0; i < 22; i++) await start(h, 60 + i, `t${i}`);
		const adapter = h.toolchain.registry.get("adapter:timers@1")!;
		expect(
			h.store.read((db) => adapter.choicesInTransaction!(db, TARGET)),
		).toHaveLength(20);
	} finally {
		await h.close();
	}
});
