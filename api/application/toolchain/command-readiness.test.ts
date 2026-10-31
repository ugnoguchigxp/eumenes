import { expect, spyOn, test } from "bun:test";
import { waitFor, settle } from "../../infrastructure/wait-for";
import { harness } from "./toolchain.fixture";

const command = JSON.stringify({
	action: "invoke",
	tool: "timer.start",
	arguments: { durationSeconds: 180 },
});

test("a command that becomes ready after 55 seconds still executes once within its conversation deadline", async () => {
	let elapsed = 0;
	const h = await harness({
		timers: true,
		command: () => {
			// Model the elapsed preparation time without waiting on a live provider.
			elapsed = 55_000;
			return command;
		},
	});
	const now = Date.now.bind(Date);
	const clock = spyOn(Date, "now").mockImplementation(() => now() + elapsed);
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "3分タイマーを開始して",
		});
		await waitFor(() =>
			["completed", "failed"].includes(h.dialogue.get(run.id)!.status),
		);
		expect(h.dialogue.get(run.id)?.status).toBe("completed");
		expect(
			h.store.read((db) =>
				db.query("SELECT duration_seconds, state FROM timers").all(),
			),
		).toEqual([{ duration_seconds: 180, state: "active" }]);
		expect(h.commandContexts).toHaveLength(1);
	} finally {
		clock.mockRestore();
		await h.close();
	}
});

for (const elapsedMs of [166_000, 181_000])
	test(`a command returned after ${elapsedMs}ms cannot consume the answer reserve or start an expired operation`, async () => {
		let elapsed = 0;
		const h = await harness({
			timers: true,
			command: () => {
				elapsed = elapsedMs;
				return command;
			},
		});
		const now = Date.now.bind(Date);
		const clock = spyOn(Date, "now").mockImplementation(() => now() + elapsed);
		try {
			const run = await h.dialogue.submit({
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text: "3分タイマーを開始して",
			});
			await waitFor(() => h.dialogue.get(run.id)?.status === "failed");
			await settle();
			expect(
				h.store.read((db) => db.query("SELECT id FROM timers").all()),
			).toEqual([]);
		} finally {
			clock.mockRestore();
			await h.close();
		}
	});

test("cancelling while a command is preparing prevents its late answer from starting an operation", async () => {
	const ready = Promise.withResolvers<void>();
	const returned = Promise.withResolvers<void>();
	const h = await harness({
		timers: true,
		commandGate: ready.promise,
		command: () => {
			returned.resolve();
			return command;
		},
	});
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "3分タイマーを開始して",
		});
		await waitFor(() => h.commandContexts.length === 1);
		await h.dialogue.cancel(run.id);
		ready.resolve();
		await returned.promise;
		await settle();
		expect(h.dialogue.get(run.id)?.status).toBe("cancelled");
		expect(
			h.store.read((db) => db.query("SELECT id FROM timers").all()),
		).toEqual([]);
	} finally {
		ready.resolve();
		await h.close();
	}
});
