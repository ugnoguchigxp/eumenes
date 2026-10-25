import { browserTiming } from "../../../performance";
import VadWorker from "../worklet/vad.worker.ts?worker";
import type { VadRequest, VadResponse } from "../worklet/vad.worker";

/** Speech probability of 512-sample 16 kHz windows, classified in the order they are given. */
export type SpeechClassifier = {
	classify(window: Float32Array): number | Promise<number>;
	/** Starts a new stream: the model forgets what it heard. */
	reset(): void;
	close(): void;
};

const LOAD_LIMIT_MS = 15_000;
/** An answer this late means the worker has stalled: detection would silently stop. */
const ANSWER_LIMIT_MS = 3_000;
/** Answers slower than this are recorded (User Timing) to find a too-slow device. */
const SLOW_ANSWER_MS = 300;

/** Loads the model in a worker; rejects with `voice_detector_unavailable` when it cannot. */
export function createSpeechClassifier(): Promise<SpeechClassifier> {
	const worker = new VadWorker();
	const send = (request: VadRequest, transfer: Transferable[] = []) =>
		worker.postMessage(request, transfer);
	const pending = new Map<
		number,
		{
			resolve: (p: number) => void;
			reject: (e: Error) => void;
			sent: number;
		}
	>();
	let nextId = 0;
	let closed = false;
	const unavailable = () => new Error("voice_detector_unavailable");
	const close = () => {
		closed = true;
		worker.terminate();
		for (const { reject } of pending.values()) reject(unavailable());
		pending.clear();
	};
	const classifier: SpeechClassifier = {
		classify(window) {
			if (closed) return Promise.reject(unavailable());
			const oldest = pending.values().next().value;
			if (oldest && performance.now() - oldest.sent > ANSWER_LIMIT_MS) {
				close();
				return Promise.reject(unavailable());
			}
			const id = nextId++;
			const copy = window.slice();
			return new Promise<number>((resolve, reject) => {
				pending.set(id, { resolve, reject, sent: performance.now() });
				send({ type: "classify", id, window: copy }, [copy.buffer]);
			});
		},
		reset: () => {
			if (!closed) send({ type: "reset" });
		},
		close,
	};
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			close();
			reject(unavailable());
		}, LOAD_LIMIT_MS);
		const fail = () => {
			clearTimeout(timer);
			close();
			reject(unavailable());
		};
		worker.onerror = fail;
		worker.onmessage = (event: MessageEvent<VadResponse>) => {
			const message = event.data;
			if (message.type === "ready") {
				clearTimeout(timer);
				resolve(classifier);
			} else if (message.type === "failed") fail();
			else {
				const request = pending.get(message.id);
				pending.delete(message.id);
				if (!request) return;
				if (performance.now() - request.sent > SLOW_ANSWER_MS)
					browserTiming("vad_answer", {}, request.sent);
				request.resolve(message.probability);
			}
		};
	});
}
