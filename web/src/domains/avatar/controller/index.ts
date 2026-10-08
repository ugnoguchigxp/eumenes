import type { AvatarMotion } from "../../../../../api/domains/delivery";

export type AvatarCue = {
	key: string;
	motion: AvatarMotion;
	speaking?: boolean;
};
type Model = {
	beginMotion(): void;
	render(
		time?: number,
		motion?: AvatarMotion,
		elapsed?: number,
		speaking?: boolean,
	): void;
};

export function createAvatarPlayback(
	model: Model,
	options: {
		reduced?: boolean;
		now?: () => number;
		requestFrame?: (callback: FrameRequestCallback) => number;
		cancelFrame?: (id: number) => void;
		onError?: () => void;
	} = {},
) {
	const now = options.now ?? (() => performance.now());
	const request = options.requestFrame ?? requestAnimationFrame;
	const cancel = options.cancelFrame ?? cancelAnimationFrame;
	const origin = now();
	let frame = 0,
		started = origin,
		lastFrame = -Infinity,
		elapsed = 0,
		clock = 0;
	let motion: AvatarMotion = "neutral";
	let selected: AvatarMotion = "neutral";
	let key: string | null = null;
	let speaking = false;
	let disposed = false;
	let epoch = 0;
	const stop = () => {
		epoch++;
		cancel(frame);
		frame = 0;
	};
	function draw() {
		if (disposed) return;
		try {
			if (speaking) model.render(clock, motion, elapsed, true);
			else model.render(clock, motion, elapsed);
		} catch {
			stop();
			disposed = true;
			options.onError?.();
		}
	}
	function tick(timestamp: number, generation: number) {
		if (disposed || generation !== epoch) return;
		if (
			timestamp - lastFrame >=
			1000 / (motion === "neutral" && !speaking ? 12 : 24)
		) {
			lastFrame = timestamp;
			clock = Math.max(0, (timestamp - origin) / 1000);
			const age = Math.max(0, (timestamp - started) / 1000);
			const recovering = !speaking && selected !== "neutral" && age >= 8;
			motion = recovering ? "neutral" : selected;
			elapsed = recovering ? age - 8 : age;
			draw();
		}
		if (!disposed && generation === epoch)
			frame = request((timestamp) => tick(timestamp, generation));
		else stop();
	}
	if (options.reduced) {
		elapsed = 1;
		draw();
	} else {
		const generation = epoch;
		frame = request((timestamp) => tick(timestamp, generation));
	}
	return {
		setCue(cue: AvatarCue | null) {
			if (disposed || key === (cue?.key ?? null)) return;
			key = cue?.key ?? null;
			stop();
			selected = motion = cue?.motion ?? "neutral";
			speaking = cue?.speaking === true && !options.reduced;
			model.beginMotion();
			if (options.reduced) {
				motion = "neutral";
				elapsed = 1;
				clock = 0;
				draw();
				return;
			}
			started = now();
			clock = Math.max(clock, (started - origin) / 1000);
			lastFrame = -Infinity;
			elapsed = 0;
			draw();
			if (disposed) return;
			const generation = epoch;
			frame = request((timestamp) => tick(timestamp, generation));
		},
		redraw: draw,
		dispose() {
			disposed = true;
			stop();
		},
	};
}
