import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createToolchainRouting } from "./toolchain-routing";
import { questionReader } from "./toolchain-adapters";
import { harness } from "./toolchain.fixture";

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
		for (const other of ["builtin:answerText", "builtin:timerDurationAnswer"])
			expect(
				h.store.read((db) => adapter.choicesInTransaction!(db, other)),
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
					"binding:timers.command@1",
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

test("the question source shows only the question and its status, not the interaction's refs", () => {
	const full = {
		id: "interaction-1",
		conversationId: "main",
		status: "waiting_input",
		revision: 2,
		chainRevisionId: "toolchain:timers.manage@2",
		artifactRevisionId: "artifact:timers.workspace@1",
		question: {
			questionId: "q",
			prompt: "どれですか",
			inputSchemaRef: TARGET,
			revision: 2,
			expiresAt: "2026-10-14T00:00:00.000Z",
			choices: [{ ref: "t1", label: "お茶" }],
		},
		questionCount: 1,
		receiptRef: { owner: "timers", operationId: "o", digest: "d" },
		expiresAt: "2026-10-14T00:00:00.000Z",
		createdAt: "x",
		updatedAt: "y",
	};
	const reader = questionReader(() => ({
		viewInTransaction: (_db: Database, id: string) =>
			id === full.id ? full : null,
	}))()!;
	expect(reader.questionInTransaction({} as Database, full.id)).toEqual({
		revision: 2,
		data: { status: "waiting_input", question: full.question },
	});
	// Without an open question there is no source.
	const closed = questionReader(() => ({
		viewInTransaction: () => ({ ...full, question: null }),
	}))()!;
	expect(closed.questionInTransaction({} as Database, full.id)).toBeNull();
	expect(reader.questionInTransaction({} as Database, "other")).toBeNull();
});
