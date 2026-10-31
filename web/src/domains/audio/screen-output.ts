import { createAudioController, type OutputController } from "./controller";

type Owned = { device: string; audio: OutputController; started: boolean };

const defaultOutput = (outputDevice: string): OutputController =>
	createAudioController(
		() => {},
		() => {},
		() => {},
		{ outputDevice, keepAlive: false },
	);

/**
 * One screen's sound (spec tts-single-lane §4.4): one output controller for read-aloud and notices,
 * and two lanes that never sound together. A notice waits for the utterance in progress (speech goes
 * first); a clause waits for the notice that is sounding. Notices take turns in arrival order. A voice
 * session's own controller is used while one runs; its turns count as speech through `speechElsewhere`.
 */
export function createScreenOutput(
	create: (outputDevice: string) => OutputController = defaultOutput,
) {
	let owned: Owned | null = null;
	let utterances = 0;
	let speechElsewhere = () => false;
	let sounding = false;
	// Notices take numbered turns; a turn given up while waiting is skipped.
	let issued = 0;
	let serving = 0;
	const abandoned = new Set<number>();
	const waiters = new Set<() => void>();
	const changed = () => {
		for (const waiter of waiters) waiter();
	};
	const speaking = () => utterances > 0 || speechElsewhere();
	function until(ready: () => boolean, signal?: AbortSignal) {
		return new Promise<void>((resolve, reject) => {
			const done = () => {
				waiters.delete(check);
				signal?.removeEventListener("abort", check);
			};
			function check() {
				if (signal?.aborted) {
					done();
					reject(signal.reason);
				} else if (ready()) {
					done();
					resolve();
				}
			}
			waiters.add(check);
			signal?.addEventListener("abort", check, { once: true });
			check();
		});
	}
	function discard(entry: Owned | null) {
		// A replaced controller was stopped when it was replaced.
		if (!entry || owned !== entry) return;
		owned = null;
		void entry.audio.stop();
	}
	return {
		/** This screen's controller for the device (not started); a changed device replaces it. */
		controller(outputDevice: string): Owned {
			if (owned?.device !== outputDevice) {
				discard(owned);
				owned = {
					device: outputDevice,
					audio: create(outputDevice),
					started: false,
				};
			}
			return owned;
		},
		/** Stops and forgets this controller unless another has replaced it already. */
		discard,
		/**
		 * Starts (unlocks) the controller. One that never started is dropped on failure; a started one is
		 * shared by speech and notices and stays, so a cancelled notice cannot lock read-aloud out.
		 */
		async start(entry: Owned) {
			try {
				await entry.audio.startOutput();
				entry.started = true;
			} catch (error) {
				if (!entry.started) discard(entry);
				throw error;
			}
		},
		/** Drops a controller that never started (an output stalled before a gesture). */
		discardUnstarted: (entry: Owned | null) => {
			if (entry && !entry.started) discard(entry);
		},
		release: () => discard(owned),
		/** Tells the lanes how to know a voice turn is speaking on the session's controller. */
		setSpeechElsewhere(busy: () => boolean) {
			speechElsewhere = busy;
			changed();
		},
		/** Re-evaluates the lanes after `speechElsewhere` may have changed. */
		changed,
		speaking,
		/** A reading holds the speech lane until the returned release; notices wait for it. */
		beginSpeech() {
			utterances++;
			changed();
			let released = false;
			return () => {
				if (released) return;
				released = true;
				utterances--;
				changed();
			};
		},
		/** Each clause waits for the notice that is sounding. */
		noticeQuiet: (signal?: AbortSignal) => until(() => !sounding, signal),
		/** A notice sounds alone, after the utterance in progress and the notices before it. */
		async notice<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
			const turn = issued++;
			const next = () => {
				serving++;
				while (abandoned.delete(serving)) serving++;
				changed();
			};
			const ready = () => serving === turn && !speaking();
			// A free lane starts at once (no extra turn of the event loop before the notice begins).
			if (!ready())
				try {
					await until(ready, signal);
				} catch (error) {
					if (serving === turn) next();
					else abandoned.add(turn);
					throw error;
				}
			sounding = true;
			try {
				return await work();
			} finally {
				sounding = false;
				next();
			}
		},
	};
}
export type ScreenOutput = ReturnType<typeof createScreenOutput>;
