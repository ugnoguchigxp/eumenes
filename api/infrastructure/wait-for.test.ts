import { expect, test } from "bun:test";
import { waitFor } from "./wait-for";

test("resolves once the condition holds, without waiting out the timeout", async () => {
	let ticks = 0;
	const started = performance.now();
	await waitFor(() => ++ticks >= 3, { timeout: 5000 });
	expect(ticks).toBe(3);
	expect(performance.now() - started).toBeLessThan(1000);
});

test("accepts an async condition and fails when it is never met", async () => {
	await waitFor(async () => true);
	await expect(waitFor(() => false, { timeout: 20 })).rejects.toThrow(
		"wait_for_timeout",
	);
});
