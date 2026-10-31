import recorderUrl from "./worklet/recorder.worklet.ts?worker&url";

export function pcm16(samples: Float32Array): Uint8Array {
	const out = new Uint8Array(samples.length * 2);
	const view = new DataView(out.buffer);
	for (let i = 0; i < samples.length; i++) {
		const v = Math.max(-1, Math.min(1, samples[i] ?? 0));
		view.setInt16(i * 2, Math.round(v < 0 ? v * 32768 : v * 32767), true);
	}
	return out;
}
/** Stateful sample conversion keeps fractional phase across microphone frames. */
export function resampler(inputRate: number, outputRate = 24000) {
	let phase = 0;
	let pending = new Float32Array();
	const ratio = inputRate / outputRate;
	return (frame: Float32Array) => {
		const joined = new Float32Array(pending.length + frame.length);
		joined.set(pending);
		joined.set(frame, pending.length);
		const out: number[] = [];
		while (phase + 1 < joined.length) {
			const i = Math.floor(phase);
			const w = phase - i;
			out.push(joined[i]! * (1 - w) + joined[i + 1]! * w);
			phase += ratio;
		}
		const consumed = Math.min(Math.floor(phase), joined.length);
		pending = joined.slice(consumed);
		phase -= consumed;
		return pcm16(new Float32Array(out));
	};
}
const base64 = (bytes: Uint8Array) => {
	let text = "";
	for (const value of bytes) text += String.fromCharCode(value);
	return btoa(text);
};
export async function createLivePcm(options: {
	inputDevice: string;
	outputDevice: string;
	echoCancellation: boolean;
	noiseSuppression: boolean;
	autoGainControl: boolean;
	volume: number;
	muted: boolean;
	onInput: (audio: string) => void;
	onPlaying: (playing: boolean) => void;
	onError: () => void;
}) {
	const context = new AudioContext();
	let stream: MediaStream | undefined;
	let node: AudioWorkletNode | undefined;
	let source: MediaStreamAudioSourceNode | undefined;
	let muted = options.muted,
		closed = false,
		nextAt = 0;
	const playing = new Set<AudioBufferSourceNode>();
	const gain = context.createGain();
	gain.gain.value = options.volume;
	gain.connect(context.destination);
	const close = () => {
		if (closed) return;
		closed = true;
		for (const track of stream?.getTracks() ?? []) track.stop();
		node?.disconnect();
		source?.disconnect();
		for (const p of playing) p.stop();
		playing.clear();
		void context.close();
		options.onPlaying(false);
	};
	try {
		if (options.outputDevice && "setSinkId" in context)
			await (
				context as AudioContext & { setSinkId: (id: string) => Promise<void> }
			).setSinkId(options.outputDevice);
		await context.resume();
		stream = await navigator.mediaDevices.getUserMedia({
			audio: {
				...(options.inputDevice
					? { deviceId: { exact: options.inputDevice } }
					: {}),
				echoCancellation: options.echoCancellation,
				noiseSuppression: options.noiseSuppression,
				autoGainControl: options.autoGainControl,
			},
		});
		for (const track of stream.getTracks()) {
			track.enabled = !muted;
			track.addEventListener("ended", () => {
				if (!closed) options.onError();
			});
		}
		await context.audioWorklet.addModule(recorderUrl);
		source = context.createMediaStreamSource(stream);
		node = new AudioWorkletNode(context, "eumenes-recorder");
		const convert = resampler(context.sampleRate);
		node.port.onmessage = (event: MessageEvent<Float32Array>) => {
			if (!closed) {
				if (muted) event.data.fill(0);
				const bytes = convert(event.data);
				if (bytes.length) options.onInput(base64(bytes));
			}
		};
		// The recorder has no audible output; it still processes silence continuously.
		source.connect(node);
		node.connect(context.destination);
	} catch (error) {
		close();
		throw error;
	}
	return {
		close,
		mute(value: boolean) {
			muted = value;
			for (const track of stream?.getAudioTracks() ?? [])
				track.enabled = !value;
		},
		play(audio: string) {
			if (closed) return;
			const binary = atob(audio);
			if (binary.length % 2) throw new Error("live_audio_invalid");
			const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
			const view = new DataView(bytes.buffer);
			if (nextAt - context.currentTime > 2)
				throw new Error("live_audio_backpressure");
			const buffer = context.createBuffer(1, bytes.length / 2, 24000);
			const channel = buffer.getChannelData(0);
			for (let i = 0; i < channel.length; i++)
				channel[i] = view.getInt16(i * 2, true) / 32768;
			const next = context.createBufferSource();
			next.buffer = buffer;
			next.connect(gain);
			playing.add(next);
			nextAt = Math.max(nextAt, context.currentTime + 0.015);
			next.start(nextAt);
			nextAt += buffer.duration;
			options.onPlaying(true);
			next.onended = () => {
				playing.delete(next);
				if (!playing.size) options.onPlaying(false);
			};
		},
	};
}
