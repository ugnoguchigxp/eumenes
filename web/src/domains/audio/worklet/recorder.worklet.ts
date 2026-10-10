// Runs on the audio rendering thread. It only forwards microphone samples;
// voice detection and WAV encoding stay in the controller on the main thread.
declare class AudioWorkletProcessor {
	readonly port: MessagePort;
}
declare function registerProcessor(
	name: string,
	processor: new () => AudioWorkletProcessor,
): void;

const FRAME = 2048;

// Batches the 128-sample render quanta so the main thread receives one message per frame.
class RecorderProcessor extends AudioWorkletProcessor {
	private buffer = new Float32Array(FRAME);
	private filled = 0;
	process(inputs: Float32Array[][]): boolean {
		const channel = inputs[0]?.[0];
		if (!channel?.length) return true;
		let offset = 0;
		while (offset < channel.length) {
			const take = Math.min(FRAME - this.filled, channel.length - offset);
			this.buffer.set(channel.subarray(offset, offset + take), this.filled);
			this.filled += take;
			offset += take;
			if (this.filled === FRAME) {
				const out = this.buffer;
				this.port.postMessage(out, [out.buffer]);
				this.buffer = new Float32Array(FRAME);
				this.filled = 0;
			}
		}
		return true;
	}
}
registerProcessor("eumenes-recorder", RecorderProcessor);
