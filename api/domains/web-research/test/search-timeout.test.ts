import { expect, spyOn, test } from "bun:test";
import { createWebAcquisition } from "..";
import { submitResearchSchema } from "../contracts";

// Exercise both the default provider deadline and the enclosing search deadline.
// The synthetic upstream never uses the network or changes library parsing rules.
for (const [delayMs, succeeds] of [
	[8200, true],
	[12000, false],
] as const)
	test(`search waits up to ten seconds: upstream delay ${delayMs}ms`, async () => {
		let calls = 0;
		const upstream: typeof globalThis.fetch = Object.assign(
			async (_url: string | URL | Request, init?: RequestInit) => {
				if (calls++ === 0)
					await new Promise<void>((resolve, reject) => {
						const signal = init?.signal;
						const timer = setTimeout(() => {
							signal?.removeEventListener("abort", abort);
							resolve();
						}, delayMs);
						function abort() {
							clearTimeout(timer);
							reject(signal?.reason);
						}
						if (signal?.aborted) abort();
						else signal?.addEventListener("abort", abort, { once: true });
					});
				// No preload token: the provider uses its existing HTML fallback.
				return new Response(
					'<html><body><div class="result"><a class="result__a" href="https://example.com/source">Public source</a><div class="result__snippet">Public information for the current request.</div></div></body></html>',
					{ headers: { "content-type": "text/html" } },
				);
			},
			{ preconnect: () => {} },
		);
		const fetch = spyOn(globalThis, "fetch").mockImplementation(upstream);
		const acquisition = createWebAcquisition();
		const started = Date.now();
		try {
			const result = acquisition.execute(
				submitResearchSchema.parse({
					requestId: crypto.randomUUID(),
					operation: "lookup",
					query: "current public information",
				}),
				AbortSignal.timeout(15000),
			);
			if (succeeds) {
				expect((await result).result.hits[0]?.url).toBe(
					"https://example.com/source",
				);
				expect(fetch).toHaveBeenCalledTimes(2);
			} else {
				await expect(result).rejects.toMatchObject({ code: "TIMEOUT" });
				expect(Date.now() - started).toBeGreaterThanOrEqual(9500);
				expect(Date.now() - started).toBeLessThan(11500);
				expect(fetch).toHaveBeenCalledTimes(1);
			}
		} finally {
			await acquisition.close();
			fetch.mockRestore();
		}
	}, 15000);
