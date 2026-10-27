/**
 * Watches for the selected output device disappearing: the AudioContext reports a sink change, or
 * the device list no longer holds the device. Returns the function that releases the listeners.
 * Detection only; nothing switches to another device.
 */
function watchOutputDevice({
	ctx,
	outputDevice,
	isCurrent,
	onLost,
}: {
	ctx: AudioContext;
	outputDevice: string;
	/** False once the context was stopped or replaced; later events are ignored. */
	isCurrent: () => boolean;
	onLost: () => void;
}): () => void {
	const cleanups: Array<() => void> = [];
	if (typeof ctx.addEventListener === "function") {
		const sinkChanged = () => {
			if (isCurrent()) onLost();
		};
		ctx.addEventListener("sinkchange", sinkChanged);
		cleanups.push(() => ctx.removeEventListener("sinkchange", sinkChanged));
	}
	const devices = navigator.mediaDevices;
	if (devices?.addEventListener && devices.enumerateDevices) {
		const changed = () => {
			void devices
				.enumerateDevices()
				.then((list) => {
					// Without device permission the list can carry no output ids at all.
					const outputs = list.filter(
						(d) => d.kind === "audiooutput" && d.deviceId,
					);
					if (
						isCurrent() &&
						outputs.length > 0 &&
						!outputs.some((d) => d.deviceId === outputDevice)
					)
						onLost();
				})
				.catch(() => {});
		};
		devices.addEventListener("devicechange", changed);
		cleanups.push(() => devices.removeEventListener("devicechange", changed));
	}
	return () => {
		for (const cleanup of cleanups.splice(0)) cleanup();
	};
}

/** Watches the selected output device once per context, across input pauses. */
export function createOutputWatch(options: {
	outputDevice: string | undefined;
	isCurrent: (ctx: AudioContext) => boolean;
	onLost: () => void;
}) {
	let watched: AudioContext | undefined;
	let release = () => {};
	return {
		watch(ctx: AudioContext) {
			const { outputDevice } = options;
			if (!outputDevice || watched === ctx) return;
			release();
			watched = ctx;
			release = watchOutputDevice({
				ctx,
				outputDevice,
				isCurrent: () => options.isCurrent(ctx),
				onLost: options.onLost,
			});
		},
		release() {
			release();
			release = () => {};
			watched = undefined;
		},
	};
}
