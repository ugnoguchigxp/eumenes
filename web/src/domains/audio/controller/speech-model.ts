import type * as Ort from "onnxruntime-web";

/** Silero VAD v5 at 16 kHz: 512 new samples per window, preceded by the last 64 of the previous one. */
export const SPEECH_WINDOW = 512;
const CONTEXT = 64;

/**
 * One utterance stream through the model: windows must be classified in order, and `reset`
 * starts a new stream (the model is stateful).
 */
export async function createSpeechModel(
	ort: typeof Ort,
	model: string | Uint8Array,
) {
	const session = await ort.InferenceSession.create(model as Uint8Array);
	const rate = new ort.Tensor("int64", BigInt64Array.from([16000n]), []);
	const initialState = (): Ort.Tensor =>
		new ort.Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
	let state = initialState();
	let context = new Float32Array(CONTEXT);
	// A reset during a run must not be undone by that run's late state.
	let stream = 0;
	return {
		async classify(window: Float32Array): Promise<number> {
			if (window.length !== SPEECH_WINDOW)
				throw new RangeError("speech window must be 512 samples");
			const input = new Float32Array(CONTEXT + SPEECH_WINDOW);
			input.set(context);
			input.set(window, CONTEXT);
			context = window.slice(SPEECH_WINDOW - CONTEXT);
			const mine = stream;
			const result = await session.run({
				input: new ort.Tensor("float32", input, [1, input.length]),
				state,
				sr: rate,
			});
			if (mine === stream) state = result.stateN as Ort.Tensor;
			return (result.output!.data as Float32Array)[0] ?? 0;
		},
		reset() {
			stream++;
			state = initialState();
			context = new Float32Array(CONTEXT);
		},
		release: () => session.release(),
	};
}
export type SpeechModel = Awaited<ReturnType<typeof createSpeechModel>>;
