import { LIVE_INPUT_PCM_MAX_BYTES } from "../../../../api/domains/live-voice/contracts";

const MAX_WAITING_CHUNKS = 24;

/** One request at a time, with the existing backlog bound and provider PCM order. */
export function createLiveAudioUpload(
	send: (sequence: number, audio: string, signal: AbortSignal) => Promise<void>,
	onFailure: (reason: "backpressure" | "send_failed") => void,
) {
	const controller = new AbortController();
	const waiting: string[] = [];
	let sending = false;
	let sequence = 0;

	function stop() {
		controller.abort();
		waiting.length = 0;
	}

	function nextPacket() {
		const first = waiting.shift()!;
		if (!waiting.length) return first;
		let bytes = atob(first);
		while (waiting.length) {
			const next = atob(waiting[0]!);
			if (bytes.length + next.length > LIVE_INPUT_PCM_MAX_BYTES) break;
			bytes += next;
			waiting.shift();
		}
		return btoa(bytes);
	}

	async function flush(audio: string) {
		sending = true;
		try {
			for (;;) {
				await send(++sequence, audio, controller.signal);
				if (controller.signal.aborted || !waiting.length) return;
				audio = nextPacket();
			}
		} catch {
			if (!controller.signal.aborted) {
				stop();
				onFailure("send_failed");
			}
		} finally {
			sending = false;
		}
	}

	return {
		push(audio: string) {
			if (controller.signal.aborted) return;
			if (!sending) {
				void flush(audio);
			} else if (waiting.length < MAX_WAITING_CHUNKS) {
				waiting.push(audio);
			} else {
				stop();
				onFailure("backpressure");
			}
		},
		stop,
	};
}
