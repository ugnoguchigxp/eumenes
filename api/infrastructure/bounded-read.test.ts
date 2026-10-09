import { expect, test } from "bun:test";
import { readBounded } from "./bounded-read";

const options = { limit: 8, tooLarge: "too_large", missing: "missing" };
const stream = (...parts: number[][]) =>
	new ReadableStream<Uint8Array>({
		start(controller) {
			for (const part of parts) controller.enqueue(new Uint8Array(part));
			controller.close();
		},
	});

test("reads a body within the limit", async () => {
	const bytes = await readBounded(stream([1, 2], [3, 4, 5]), options);
	expect([...bytes]).toEqual([1, 2, 3, 4, 5]);
});

test("rejects a missing body and an oversized body", async () => {
	await expect(readBounded(null, options)).rejects.toThrow("missing");
	await expect(
		readBounded(stream([1, 2, 3, 4, 5], [6, 7, 8, 9]), options),
	).rejects.toThrow("too_large");
});

test("an oversized body cancels the source and releases the lock", async () => {
	let cancelled = false;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			controller.enqueue(new Uint8Array(5));
		},
		cancel() {
			cancelled = true;
		},
	});
	await expect(readBounded(body, options)).rejects.toThrow("too_large");
	expect(cancelled).toBe(true);
	expect(body.locked).toBe(false);
});

test("an abort mid-read cancels the source and throws the reason", async () => {
	let cancelled = false;
	const body = new ReadableStream<Uint8Array>({
		pull: () => new Promise(() => {}),
		cancel() {
			cancelled = true;
		},
	});
	const controller = new AbortController();
	const pending = readBounded(body, { ...options, signal: controller.signal });
	controller.abort(new Error("deadline"));
	await expect(pending).rejects.toThrow();
	expect(cancelled).toBe(true);
	expect(body.locked).toBe(false);
});
