import { expect, spyOn, test } from "bun:test";
import { waitFor, settle } from "../../infrastructure/wait-for";
import { replyWith } from "../agency/always-on.fixture";
import { assignmentFixture } from "./assignment.fixture";

const command = JSON.stringify({
	action: "invoke",
	tool: "timer.start",
	arguments: { durationSeconds: 180 },
});

test("a command that becomes ready after 40 seconds still executes once within its model step's validity", async () => {
	let elapsed = 0;
	const f = await assignmentFixture({
		timers: true,
		command: () => {
			// Model the elapsed preparation time without waiting on a live provider.
			elapsed = 40_000;
			return command;
		},
	});
	const now = Date.now.bind(Date);
	const clock = spyOn(Date, "now").mockImplementation(() => now() + elapsed);
	try {
		await f.assign("3分タイマーを開始して", "timers.manage");
		await f.settled();
		expect(f.executions()).toMatchObject([{ status: "completed" }]);
		expect(
			f.h.store.read((db) =>
				db.query("SELECT duration_seconds, state FROM timers").all(),
			),
		).toEqual([{ duration_seconds: 180, state: "active" }]);
		expect(f.h.commandContexts).toHaveLength(1);
	} finally {
		clock.mockRestore();
		await f.close();
	}
});

for (const elapsedMs of [50_000, 3_600_000])
	test(`a command returned after ${elapsedMs}ms is past its model step's validity and cannot start an operation`, async () => {
		let elapsed = 0;
		const f = await assignmentFixture({
			timers: true,
			command: () => {
				elapsed = elapsedMs;
				return command;
			},
		});
		const now = Date.now.bind(Date);
		const clock = spyOn(Date, "now").mockImplementation(() => now() + elapsed);
		try {
			await f.assign("3分タイマーを開始して", "timers.manage");
			await f.settled();
			expect(f.executions().map((e) => e.status)).toEqual(["failed"]);
			expect(
				f.h.store.read((db) => db.query("SELECT id FROM timers").all()),
			).toEqual([]);
		} finally {
			clock.mockRestore();
			await f.close();
		}
	});

test("cancelling the assignment while a command is preparing prevents its late answer from starting an operation", async () => {
	const ready = Promise.withResolvers<void>();
	const returned = Promise.withResolvers<void>();
	const f = await assignmentFixture({
		timers: true,
		commandGate: ready.promise,
		command: () => {
			returned.resolve();
			return command;
		},
	});
	try {
		await f.assign("3分タイマーを開始して", "timers.manage");
		await waitFor(() => f.h.commandContexts.length === 1);
		await f.until(() => f.items().length === 1);
		const words = await f.userWords("やっぱりやめて");
		await replyWith(
			f.f,
			[
				{
					name: "assignment",
					arguments: { id: f.items()[0]!.id, action: "cancel" },
				},
			],
			{ runId: "run-cancel", messageIds: [words.messageId] },
		);
		await f.until(() => f.executions()[0]?.status === "cancelled");
		ready.resolve();
		await returned.promise;
		await settle();
		expect(f.executions()).toMatchObject([{ status: "cancelled" }]);
		expect(
			f.h.store.read((db) => db.query("SELECT id FROM timers").all()),
		).toEqual([]);
	} finally {
		ready.resolve();
		await f.close();
	}
});
