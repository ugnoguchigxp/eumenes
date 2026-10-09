/**
 * Foreground priority (P4-03). Conversation, ASR and TTS always win over
 * background extraction. The handler only needs to ask "is the foreground
 * using the Local resources right now?" and to hear when that changes; WHO
 * is foreground is decided by the host, which hands a signal in.
 *
 * Nothing here sleeps, polls on a timer or reads a clock: the answer is
 * computed on demand from the probes, and a change is pushed to subscribers.
 * Tests inject the whole signal (or just a probe).
 */

/** What extraction consults. Synchronous and cheap: it runs inside writer callbacks. */
export type ForegroundSignal = {
	/** True while a conversation, ASR or TTS turn needs the Local resources. */
	active(): boolean;
	/** Notified after any change of the answer. Returns the unsubscribe function. */
	subscribe?(listener: () => void): () => void;
};

/** A signal the host feeds from probes and from explicit begin/end marks. */
export type ForegroundHub = ForegroundSignal & {
	subscribe(listener: () => void): () => void;
	/** Marks the foreground busy until the returned function is called (idempotent). */
	hold(reason: string): () => void;
	/** Adds a probe: true while that foreground source is busy. Returns the removal function. */
	addProbe(probe: () => boolean): () => void;
	/**
	 * Re-evaluates the probes and notifies the subscribers when the answer
	 * changed since the last evaluation. Call it from every event that can move
	 * a probe (a commit, a request starting or ending).
	 */
	refresh(): void;
	/** Reasons of the explicit holds (diagnostics; never content). */
	holds(): string[];
};

export function createForegroundHub(): ForegroundHub {
	const probes = new Set<() => boolean>();
	const marks = new Map<symbol, string>();
	const listeners = new Set<() => void>();
	let last = false;

	const evaluate = (): boolean => {
		if (marks.size > 0) return true;
		for (const probe of probes) {
			let busy = false;
			try {
				busy = probe();
			} catch {
				// A broken probe must never read as "idle": fail toward the foreground.
				busy = true;
			}
			if (busy) return true;
		}
		return false;
	};
	const notify = () => {
		for (const listener of listeners) {
			try {
				listener();
			} catch {
				// A subscriber's failure never reaches the foreground path.
			}
		}
	};
	const refresh = () => {
		const now = evaluate();
		if (now === last) return;
		last = now;
		notify();
	};

	return {
		active: evaluate,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		hold(reason) {
			const token = Symbol(reason);
			marks.set(token, reason);
			refresh();
			return () => {
				if (marks.delete(token)) refresh();
			};
		},
		addProbe(probe) {
			probes.add(probe);
			refresh();
			return () => {
				if (probes.delete(probe)) refresh();
			};
		},
		refresh,
		holds: () => [...marks.values()].sort(),
	};
}
