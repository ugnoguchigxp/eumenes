import { expect, test } from "bun:test";
import { createStartupGate } from "./shutdown";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("settled waits for the step in flight before shutdown proceeds", async () => {
	const gate = createStartupGate();
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	const started = gate.step(() => pending);
	const calls: string[] = [];
	const shutdown = (async () => {
		await gate.settled();
		calls.push("closeAll");
	})();
	await flush();
	expect(calls).toEqual([]);
	release();
	await started;
	await shutdown;
	expect(calls).toEqual(["closeAll"]);
});

test("settled resolves even when the step rejects, and the step still rejects", async () => {
	const gate = createStartupGate();
	const failed = gate.step(async () => {
		throw new Error("boom");
	});
	await expect(failed).rejects.toThrow("boom");
	await gate.settled();
});

test("with no step in flight settled resolves at once", async () => {
	await createStartupGate().settled();
});
