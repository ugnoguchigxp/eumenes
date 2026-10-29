import type { AvatarMotion } from "../../../../../api/domains/delivery/contracts";

export type AvatarCue = {
	key: string;
	motion: AvatarMotion;
	speaking?: boolean;
};
/** Reaction variants of the `touched` motion, by what was touched. */
const reactions = {
	head: "touched-head",
	body: "touched-body",
	repeated: "touched-startle",
} as const;
/** Touches inside the rest window keep the reaction; the third within the count window startles. */
const touchRestMs = 600;
const touchCountMs = 4000;
type Model = {
	beginMotion(): void;
	/** Returns the reaction's length in seconds, 0 if the variant is unknown. */
	react(variant: string): number;
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
	let touches: number[] = [],
		reactedAt = -Infinity,
		reactingUntil = -Infinity;
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
			1000 /
				(motion === "neutral" && !speaking && timestamp >= reactingUntil
					? 12
					: 24)
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
		/** A touch on the spirit; returns whether a reaction started (reduced motion never moves). */
		react(part: "head" | "body") {
			if (disposed || options.reduced) return false;
			const at = now();
			touches = [...touches.filter((t) => at - t < touchCountMs), at];
			if (at - reactedAt < touchRestMs) return false;
			const seconds = model.react(
				touches.length >= 3 ? reactions.repeated : reactions[part],
			);
			if (!seconds) return false;
			reactedAt = at;
			reactingUntil = at + seconds * 1000;
			lastFrame = -Infinity;
			return true;
		},
		redraw: draw,
		dispose() {
			disposed = true;
			stop();
		},
	};
}
