import { expect, test, vi } from "vitest";
import { watchRunSpeech } from "../run-speech";
import type { RunSpeechEvent } from "../../api/domains/voice-dialogue/contracts";
const base = { runId: "run", sessionId: crypto.randomUUID() };
const first = crypto.randomUUID(),
	second = crypto.randomUUID();
const generation = (generationId: string): RunSpeechEvent => ({
	...base,
	type: "generation",
	generationId,
});
const audio = (generationId: string, index: number): RunSpeechEvent => ({
	...base,
	type: "audio",
	generationId,
	index,
	text: "句。",
	wav: "YQ==",
});
const start: RunSpeechEvent = { ...base, type: "start" };
const end: RunSpeechEvent = { ...base, type: "finished" };
function stream(events: RunSpeechEvent[]) {
	const values: RunSpeechEvent[] = [];
	const call = vi.fn(
		async () =>
			new Response(
				events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
				{ headers: { "Content-Type": "text/event-stream" } },
			),
	);
	const done = watchRunSpeech(
		{ identity: "fixture", call },
		"run",
		"screen",
		new AbortController().signal,
		(e) => values.push(e),
	);
	return { done, values, call };
}
test("retired generations, duplicate and late audio frames never reach playback", async () => {
	const f = stream([
		start,
		generation(first),
		audio(first, 0),
		audio(first, 0),
		generation(second),
		audio(first, 1),
		generation(first),
		audio(second, 2),
		audio(second, 1),
		end,
	]);
	await f.done;
	expect(
		f.values.filter((e) => e.type === "audio").map((e) => e.index),
	).toEqual([0, 2]);
	expect(
		f.values.filter((e) => e.type === "generation").map((e) => e.generationId),
	).toEqual([first, second]);
});
test("a disconnected stream is terminal and never retried", async () => {
	const f = stream([start, generation(first), audio(first, 0)]);
	await expect(f.done).rejects.toThrow("speech_stream_disconnected");
	expect(f.call).toHaveBeenCalledOnce();
});
test("another run, session or unannounced generation is rejected", async () => {
	for (const event of [
		{ ...audio(first, 0), runId: "other" },
		{ ...audio(first, 0), sessionId: crypto.randomUUID() },
		audio(second, 0),
	]) {
		const f = stream([start, generation(first), event]);
		await expect(f.done).rejects.toThrow(/speech_(stream|generation)_mismatch/);
		expect(f.values.some((e) => e.type === "audio")).toBe(false);
	}
});
