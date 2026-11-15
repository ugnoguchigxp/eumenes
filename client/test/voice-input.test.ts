import { expect, test, vi } from "vitest";
import { watchVoiceInput } from "../voice-input";
import type { VoiceTurn } from "../../api/domains/voice-dialogue/contracts";
const initial: VoiceTurn = {
	utteranceId: crypto.randomUUID(),
	sessionId: crypto.randomUUID(),
	generation: 1,
	sequence: 1,
	status: "recognizing",
	text: null,
	runId: null,
	error: null,
	revision: 0,
};
const ready: VoiceTurn = {
	...initial,
	status: "input_ready",
	text: "確定した文章",
	revision: 2,
};
function run(events: VoiceTurn[], signal = new AbortController().signal) {
	const values: VoiceTurn[] = [];
	const call = vi.fn(
		async () =>
			new Response(
				events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
				{
					headers: { "Content-Type": "text/event-stream" },
				},
			),
	);
	const done = watchVoiceInput(
		{ identity: "test", call },
		initial.utteranceId,
		signal,
		(e) => values.push(e),
	);
	return { values, done, call };
}
test("direct notification delivers only newer revisions and finishes on the accepted input", async () => {
	const f = run([
		initial,
		initial,
		{ ...initial, revision: 1 },
		initial,
		ready,
	]);
	await f.done;
	expect(f.values.map((e) => e.revision)).toEqual([0, 1, 2]);
	expect(f.values.at(-1)?.text).toBe(ready.text);
	expect(f.call).toHaveBeenCalledOnce();
});
test("disconnect does not retry recognition or treat an interim state as final", async () => {
	const f = run([initial]);
	await expect(f.done).rejects.toThrow("voice_input_disconnected");
	expect(f.call).toHaveBeenCalledOnce();
});
test("another turn or generation is never displayed", async () => {
	for (const bad of [
		{ ...ready, utteranceId: crypto.randomUUID() },
		{ ...ready, generation: 2 },
	]) {
		const f = run([initial, bad]);
		await expect(f.done).rejects.toThrow("voice_input_stream_mismatch");
		expect(f.values).toEqual([initial]);
	}
});
test("cancellation fences even a transport that ignores the signal", async () => {
	const abort = new AbortController();
	abort.abort();
	const f = run([ready], abort.signal);
	await expect(f.done).rejects.toThrow();
	expect(f.values).toEqual([]);
});
