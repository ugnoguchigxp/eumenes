import { expect, test } from "bun:test";
import { createSpeechLanguageCache } from "../service/speech-language";

const decision = {
	language: "en" as const,
	model: "fixture-language",
	latencyMs: 1,
};

test("one cancelled subscriber does not cancel another; a last cancelled subscriber cannot seed the memo", async () => {
	const cache = createSpeechLanguageCache();
	let complete!: (value: unknown) => void;
	let calls = 0;
	let providerSignal!: AbortSignal;
	const classify = (signal: AbortSignal) => {
		calls++;
		providerSignal = signal;
		return new Promise<unknown>((resolve) => {
			complete = resolve;
		});
	};
	const first = new AbortController();
	const second = new AbortController();
	const a = cache
		.select("same", "Hello world.", first.signal, classify)
		.catch(() => "cancelled");
	const b = cache.select("same", "Hello world.", second.signal, classify);
	await Promise.resolve();
	first.abort();
	expect(await a).toBe("cancelled");
	expect(providerSignal.aborted).toBe(false);
	complete(decision);
	expect(await b).toEqual(decision);
	expect(calls).toBe(1);
	expect(
		await cache.select("same", "Hello world.", second.signal, classify),
	).toEqual(decision);
	const last = new AbortController();
	const late = cache
		.select("new", "Another answer.", last.signal, classify)
		.catch(() => "cancelled");
	await Promise.resolve();
	last.abort();
	expect(await late).toBe("cancelled");
	expect(providerSignal.aborted).toBe(true);
	complete(decision);
	expect(
		await cache.select("new", "Another answer.", second.signal, async () => {
			calls++;
			return decision;
		}),
	).toEqual(decision);
	expect(calls).toBe(3);
	cache.clear();
});

test("source and authority changes cannot reuse a result; malformed output is not retained", async () => {
	const cache = createSpeechLanguageCache();
	const signal = new AbortController().signal;
	let calls = 0;
	const classify = async () => {
		calls++;
		return decision;
	};
	await cache.select("snapshot1", "Hello.", signal, classify);
	await cache.select("snapshot1", "Changed.", signal, classify);
	await cache.select("snapshot2", "Hello.", signal, classify);
	expect(calls).toBe(3);
	await expect(
		cache.select("bad", "Bonjour.", signal, async () => ({
			...decision,
			language: "fr",
		})),
	).rejects.toThrow("speech_language_invalid");
	await expect(
		cache.select("bad", "Bonjour.", signal, classify),
	).resolves.toEqual(decision);
	cache.clear();
});

test("capacity cannot evict an active classifier and clearing aborts it", async () => {
	const cache = createSpeechLanguageCache(1);
	const signal = new AbortController().signal;
	let providerSignal!: AbortSignal;
	const pending = cache
		.select("one", "One.", signal, (s) => {
			providerSignal = s;
			return new Promise((_, reject) =>
				s.addEventListener("abort", () => reject(s.reason), { once: true }),
			);
		})
		.catch(() => "stopped");
	await Promise.resolve();
	await expect(
		cache.select("two", "Two.", signal, async () => decision),
	).rejects.toThrow("speech_language_capacity");
	cache.clear();
	expect(providerSignal.aborted).toBe(true);
	expect(await pending).toBe("stopped");
});
