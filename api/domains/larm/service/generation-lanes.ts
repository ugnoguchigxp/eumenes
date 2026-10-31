import { untilAborted } from "./guards";

/** Generation admission, independent of the number of live LARM connections. */
function lane(limit: number) {
	let active = 0;
	const waiting: Array<() => void> = [];
	return async <T>(signal: AbortSignal, use: () => Promise<T>): Promise<T> => {
		signal.throwIfAborted();
		let admitted = false;
		let wake!: () => void;
		const turn = new Promise<void>((resolve) => {
			wake = () => {
				admitted = true;
				active++;
				resolve();
			};
		});
		if (active < limit) wake();
		else waiting.push(wake);
		try {
			await untilAborted(turn, signal);
			signal.throwIfAborted();
			return await use();
		} finally {
			if (admitted) {
				active--;
				waiting.shift()?.();
			} else {
				const index = waiting.indexOf(wake);
				if (index >= 0) waiting.splice(index, 1);
			}
		}
	};
}

export const createGenerationLanes = () => ({ main: lane(1), sub: lane(2) });
export type GenerationLanes = ReturnType<typeof createGenerationLanes>;
