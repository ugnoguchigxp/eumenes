// Pull-only inputs: the avatar owns the clock; no React updates, timers or network traffic.
const inputs = new Set<() => number>();

export function readAssistantMouth(): number {
	let open = 0;
	for (const read of inputs) open = Math.max(open, read());
	return open;
}

/** Tap an assistant-only output AFTER its volume gain, before any music/output mix. */
export function analyseAssistantSpeech(
	context: AudioContext,
	output: AudioNode,
	active: () => boolean,
) {
	const analyser = context.createAnalyser();
	analyser.fftSize = 1024;
	const samples = new Float32Array(analyser.fftSize);
	// An unconnected analyser output is intentional: never add a second audible path.
	output.connect(analyser);
	let open = 0;
	let last = context.currentTime;
	const read = () => {
		const time = context.currentTime;
		if (context.state !== "running" || !active()) {
			last = time;
			return (open = 0);
		}
		analyser.getFloatTimeDomainData(samples);
		let power = 0;
		for (const value of samples) power += value * value;
		const rms = Math.sqrt(power / samples.length);
		const target = Math.min(0.7, Math.max(0, (rms - 0.008) * 5));
		const dt = Math.min(0.1, Math.max(0, time - last));
		last = time;
		open +=
			(target - open) * (1 - Math.exp(-dt / (target > open ? 0.035 : 0.08)));
		if (open < 0.001) open = 0;
		return open;
	};
	inputs.add(read);
	let disposed = false;
	return () => {
		if (disposed) return;
		disposed = true;
		inputs.delete(read);
		output.disconnect(analyser);
		analyser.disconnect();
	};
}
