// Runs the voice detector's model off the main thread. Windows arrive in order and are
// answered in order; "reset" starts a new stream.
import * as ort from "onnxruntime-web/wasm";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import modelUrl from "../models/silero_vad.onnx?url";
import {
	createSpeechModel,
	type SpeechModel,
} from "../controller/speech-model";

export type VadRequest =
	| { type: "classify"; id: number; window: Float32Array }
	| { type: "reset" };
export type VadResponse =
	| { type: "ready" }
	| { type: "failed"; reason: string }
	| { type: "probability"; id: number; probability: number };

declare const self: {
	postMessage(message: VadResponse): void;
	onmessage: ((event: MessageEvent<VadRequest>) => void) | null;
};

// One thread: no SharedArrayBuffer (cross-origin isolation) is needed.
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = { wasm: wasmUrl };

let queue = Promise.resolve();
const model: Promise<SpeechModel> = createSpeechModel(ort, modelUrl);
model.then(
	() => self.postMessage({ type: "ready" }),
	(error: unknown) =>
		self.postMessage({
			type: "failed",
			reason: error instanceof Error ? error.message : "vad_model_failed",
		}),
);
self.onmessage = (event) => {
	const request = event.data;
	queue = queue.then(async () => {
		const loaded = await model;
		if (request.type === "reset") return loaded.reset();
		self.postMessage({
			type: "probability",
			id: request.id,
			probability: await loaded.classify(request.window),
		});
	});
	queue = queue.catch((error: unknown) =>
		self.postMessage({
			type: "failed",
			reason: error instanceof Error ? error.message : "vad_model_failed",
		}),
	);
};
