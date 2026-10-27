/** A live generation's body, for backend consumers only; it is never a persisted answer. */
export type AnswerStream = {
	generationId: string;
	text: string;
	signal: AbortSignal;
};

/** In-memory transport: delivering a model delta never reads or writes the database. */
export function createAnswerStreams() {
	const active = new Map<
		string,
		{ value: AnswerStream; controller: AbortController; detach: () => void }
	>();
	const watchers = new Map<string, Set<(value: AnswerStream) => void>>();
	function notify(runId: string, value: AnswerStream) {
		for (const listener of watchers.get(runId) ?? []) {
			try {
				listener(value);
			} catch {
				/* Isolated observers. */
			}
		}
	}
	function retire(runId: string, reason?: Error) {
		const entry = active.get(runId);
		if (!entry) return;
		active.delete(runId);
		entry.detach();
		if (reason) entry.controller.abort(reason);
	}
	return {
		runIds: () => active.keys(),
		retire,
		open(runId: string, generationId: string, signal: AbortSignal) {
			retire(runId, new Error("generation_replaced"));
			const controller = new AbortController();
			const scoped = AbortSignal.any([signal, controller.signal]);
			const value: AnswerStream = { generationId, text: "", signal: scoped };
			const onAbort = () => {
				if (active.get(runId)?.value === value) retire(runId);
			};
			scoped.addEventListener("abort", onAbort, { once: true });
			active.set(runId, {
				value,
				controller,
				detach: () => scoped.removeEventListener("abort", onAbort),
			});
			if (scoped.aborted) onAbort();
			else notify(runId, { ...value });
			return (text: string) => {
				scoped.throwIfAborted();
				if (active.get(runId)?.value !== value) return;
				value.text = text;
				notify(runId, { ...value });
			};
		},
		subscribe(runId: string, listener: (value: AnswerStream) => void) {
			let set = watchers.get(runId);
			if (!set) watchers.set(runId, (set = new Set()));
			set.add(listener);
			const stop = () => {
				set.delete(listener);
				if (!set.size && watchers.get(runId) === set) watchers.delete(runId);
			};
			try {
				const entry = active.get(runId);
				if (entry) listener({ ...entry.value });
			} catch (error) {
				stop();
				throw error;
			}
			return stop;
		},
		close() {
			for (const runId of active.keys()) retire(runId, new Error("shutdown"));
			watchers.clear();
		},
	};
}
