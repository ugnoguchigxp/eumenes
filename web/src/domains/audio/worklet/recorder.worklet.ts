// Runs on the audio rendering thread. It only forwards microphone samples;
// voice detection and WAV encoding stay in the controller on the main thread.
declare class AudioWorkletProcessor {
	readonly port: MessagePort;
}
declare function registerProcessor(
	name: string,
	processor: new () => AudioWorkletProcessor,
): void;

class RecorderProcessor extends AudioWorkletProcessor {
	process(inputs: Float32Array[][]): boolean {
		const channel = inputs[0]?.[0];
		if (channel?.length) {
			const copy = new Float32Array(channel);
			this.port.postMessage(copy, [copy.buffer]);
		}
		return true;
	}
}
registerProcessor("eumenes-recorder", RecorderProcessor);
