import recorderWorkletUrl from "../worklet/recorder.worklet.ts?worker&url";
import type { AudioOptions, LostReason } from "./audio-options";
const FRAME_SAMPLES = 2048;

/** Captures microphone frames with an AudioWorklet (off the main thread). */
export async function openRecorderNode(
	ctx: AudioContext,
	onFrame: (frame: Float32Array) => void,
	onFailure: () => void,
): Promise<{ node: AudioWorkletNode; drain: () => void }> {
	if (typeof ctx.audioWorklet?.addModule !== "function")
		throw new Error("audio_worklet_unavailable");
	await ctx.audioWorklet.addModule(recorderWorkletUrl);
	const node = new AudioWorkletNode(ctx, "eumenes-recorder", {
		numberOfInputs: 1,
		numberOfOutputs: 1,
		channelCount: 1,
	});
	let pending: Float32Array[] = [];
	let pendingSamples = 0;
	const drain = () => {
		if (!pendingSamples) return;
		const frame = new Float32Array(pendingSamples);
		let offset = 0;
		for (const part of pending) {
			frame.set(part, offset);
			offset += part.length;
		}
		pending = [];
		pendingSamples = 0;
		onFrame(frame);
	};
	node.port.onmessage = (event: MessageEvent<Float32Array>) => {
		pending.push(event.data);
		pendingSamples += event.data.length;
		if (pendingSamples >= FRAME_SAMPLES) drain();
	};
	node.onprocessorerror = () => onFailure();
	return { node, drain };
}

export async function openMicrophone(
	options: AudioOptions,
): Promise<MediaStream> {
	const audioConstraints = (withDevice: boolean) => ({
		audio: {
			deviceId:
				withDevice && options.inputDevice
					? { exact: options.inputDevice }
					: undefined,
			echoCancellation: options.echoCancellation ?? true,
			noiseSuppression: options.noiseSuppression ?? true,
			autoGainControl: options.autoGainControl ?? true,
		},
	});
	try {
		return await navigator.mediaDevices.getUserMedia(audioConstraints(true));
	} catch (error) {
		const name = error instanceof Error ? error.name : "";
		// A saved device that is no longer present must not silently block voice.
		if (
			!options.inputDevice ||
			(name !== "OverconstrainedError" && name !== "NotFoundError")
		)
			throw error;
		const fallback = await navigator.mediaDevices.getUserMedia(
			audioConstraints(false),
		);
		options.onNotice?.("saved_device_missing");
		return fallback;
	}
}

/** Watches for the microphone, device list or AudioContext disappearing. */
export function watchInputDevices(
	ctx: AudioContext,
	input: MediaStream,
	isCurrent: (ctx: AudioContext) => boolean,
	reportLost: (reason: LostReason) => void,
) {
	const cleanups: Array<() => void> = [];
	const tracks = input.getAudioTracks?.() ?? [];
	for (const track of tracks) {
		const ended = () => reportLost("mic_lost");
		track.addEventListener?.("ended", ended);
		cleanups.push(() => track.removeEventListener?.("ended", ended));
	}
	const devices = navigator.mediaDevices;
	const currentId = tracks[0]?.getSettings?.().deviceId;
	if (devices?.addEventListener && devices.enumerateDevices && currentId) {
		const changed = () => {
			void devices
				.enumerateDevices()
				.then((list) => {
					if (
						!list.some(
							(d) => d.kind === "audioinput" && d.deviceId === currentId,
						)
					)
						reportLost("mic_lost");
				})
				.catch(() => {});
		};
		devices.addEventListener("devicechange", changed);
		cleanups.push(() => devices.removeEventListener("devicechange", changed));
	}
	if (typeof ctx.addEventListener === "function") {
		let resumed = false;
		const changed = () => {
			if (!isCurrent(ctx)) return;
			if (ctx.state !== "suspended" && ctx.state !== ("interrupted" as string))
				return;
			if (resumed) return reportLost("audio_context_lost");
			resumed = true;
			ctx.resume().then(
				() => {
					if (ctx.state === "running") resumed = false;
				},
				() => reportLost("audio_context_lost"),
			);
		};
		ctx.addEventListener("statechange", changed);
		cleanups.push(() => ctx.removeEventListener("statechange", changed));
	}
	return () => {
		for (const cleanup of cleanups.splice(0)) cleanup();
		return () => {};
	};
}
