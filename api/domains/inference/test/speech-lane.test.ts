import { afterEach, expect, test } from "bun:test";
import { cleanup, setup, wav, freshSignal } from "./inference.fixture";
import { waitFor } from "../../../infrastructure/wait-for";
afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});

/** A LARM voice whose syntheses finish only when the test releases them. */
function heldSpeech() {
	const started: string[] = [];
	const aborted: string[] = [];
	const pending: Array<{ text: string; finish: () => void }> = [];
	let running = 0;
	let peak = 0;
	return {
		started,
		aborted,
		peak: () => peak,
		release: (text: string) => {
			const index = pending.findIndex((p) => p.text === text);
			const [held] = pending.splice(index, 1);
			held?.finish();
		},
		speak: (text: string, signal: AbortSignal) =>
			new Promise<Uint8Array>((resolve, reject) => {
				started.push(text);
				peak = Math.max(peak, ++running);
				const done = () => {
					running--;
					signal.removeEventListener("abort", abort);
				};
				const abort = () => {
					aborted.push(text);
					done();
					reject(signal.reason);
				};
				signal.addEventListener("abort", abort, { once: true });
				pending.push({
					text,
					finish: () => {
						done();
						resolve(wav());
					},
				});
			}),
	};
}

test("speech is synthesized one request at a time in arrival order", async () => {
	const voice = heldSpeech();
	const h = await setup({ localSpeech: voice.speak });
	const first = h.inference.speak("一つ目です。", freshSignal());
	const second = h.inference.speak("二つ目です。", freshSignal());
	await waitFor(() => voice.started.length === 1);
	expect(voice.started).toEqual(["一つ目です。"]);
	voice.release("一つ目です。");
	await first;
	await waitFor(() => voice.started.length === 2);
	voice.release("二つ目です。");
	await second;
	expect(voice.started).toEqual(["一つ目です。", "二つ目です。"]);
	expect(voice.peak()).toBe(1);
});

test("a request cancelled while it waits for its turn is never sent", async () => {
	const voice = heldSpeech();
	const h = await setup({ localSpeech: voice.speak });
	const first = h.inference.speak("先です。", freshSignal());
	const cancel = new AbortController();
	const waiting = h.inference.speak("取り消します。", cancel.signal);
	const third = h.inference.speak("後です。", freshSignal());
	await waitFor(() => voice.started.length === 1);
	cancel.abort();
	await expect(waiting).rejects.toBeDefined();
	voice.release("先です。");
	await first;
	await waitFor(() => voice.started.length === 2);
	voice.release("後です。");
	await third;
	expect(voice.started).toEqual(["先です。", "後です。"]);
});

test("the same speech asked again before it is made joins that synthesis", async () => {
	const voice = heldSpeech();
	const h = await setup({ localSpeech: voice.speak });
	const a = h.inference.speak("同じ文です。", freshSignal());
	const b = h.inference.speak("同じ文です。", freshSignal());
	await waitFor(() => voice.started.length === 1);
	voice.release("同じ文です。");
	expect(await a).toEqual(wav());
	expect(await b).toEqual(wav());
	expect(voice.started).toEqual(["同じ文です。"]);
	const usage = h.inference.usage() as Array<{ accepted: number }>;
	expect(usage.filter((u) => u.accepted)).toHaveLength(1);
	// Made speech is not kept: asking again synthesizes again.
	const again = h.inference.speak("同じ文です。", freshSignal());
	await waitFor(() => voice.started.length === 2);
	voice.release("同じ文です。");
	await again;
	expect(voice.started).toHaveLength(2);
});

test("a joined synthesis stops only when every caller has cancelled", async () => {
	const voice = heldSpeech();
	const h = await setup({ localSpeech: voice.speak });
	const leaving = new AbortController();
	const staying = new AbortController();
	const left = h.inference.speak("待ちます。", leaving.signal);
	const kept = h.inference.speak("待ちます。", staying.signal);
	await waitFor(() => voice.started.length === 1);
	leaving.abort();
	await expect(left).rejects.toBeDefined();
	expect(voice.aborted).toEqual([]);
	voice.release("待ちます。");
	expect(await kept).toEqual(wav());

	const one = new AbortController();
	const two = new AbortController();
	const first = h.inference.speak("止めます。", one.signal);
	const second = h.inference.speak("止めます。", two.signal);
	await waitFor(() => voice.started.length === 2);
	const refused = Promise.all(
		[first, second].map((p) =>
			p.then(
				() => false,
				() => true,
			),
		),
	);
	one.abort();
	two.abort();
	expect(await refused).toEqual([true, true]);
	await waitFor(() => voice.aborted.length === 1);
	expect(voice.aborted).toEqual(["止めます。"]);
});

test("different voice settings or text are separate syntheses", async () => {
	const voice = heldSpeech();
	const h = await setup({ localSpeech: voice.speak });
	const plain = h.inference.speak("別です。", freshSignal());
	const other = h.inference.speak("別です。", freshSignal(), { speed: 1.2 });
	const text = h.inference.speak("違う文です。", freshSignal());
	await waitFor(() => voice.started.length === 1);
	voice.release("別です。");
	await plain;
	await waitFor(() => voice.started.length === 2);
	voice.release("別です。");
	await other;
	await waitFor(() => voice.started.length === 3);
	voice.release("違う文です。");
	await text;
	expect(voice.started).toEqual(["別です。", "別です。", "違う文です。"]);
});
