import { afterEach, expect, test, vi } from "vitest";
import { browserTiming, timedAudioDecode } from "../../../performance";

afterEach(() => vi.unstubAllGlobals());

test("browser observations are bounded and keep only the supplied timing identity", () => {
	const entries: unknown[] = [];
	const measure = vi.fn((_name, options) => entries.push(options));
	const clearMeasures = vi.fn(() => {
		entries.length = 0;
	});
	vi.stubGlobal("performance", {
		now: () => 20,
		getEntriesByName: () => entries,
		measure,
		clearMeasures,
	});
	for (let i = 0; i < 65; i++)
		browserTiming("audio_fetch", { utteranceId: "u", chunkIndex: i }, 10);
	expect(clearMeasures).toHaveBeenCalledOnce();
	expect(entries).toEqual([
		{ start: 10, end: 20, detail: { utteranceId: "u", chunkIndex: 64 } },
	]);
});

test("missing User Timing support does not prevent decoding", async () => {
	vi.stubGlobal("performance", { now: () => 20 });
	const buffer = {} as AudioBuffer;
	const context = {
		decodeAudioData: vi.fn(async () => buffer),
	} as unknown as AudioContext;
	expect(await timedAudioDecode(context, new Uint8Array([1, 2]))).toBe(buffer);
});
