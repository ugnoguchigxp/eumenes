import { byId } from "../repository";
import type { RunProgress } from "../contracts";
import type { DialogueDeps } from "./context";
import { createAnswerStreams } from "./answer-streams";

/** Progress watchers and their commit-driven refresh. */
export function createProgress(deps: DialogueDeps) {
	const { store, conversation } = deps;
	const watchers = new Map<string, Set<(value: RunProgress) => void>>();
	// Only persisted state is cached here; model deltas never query SQLite.
	const watched = new Map<string, RunProgress>();
	const streams = createAnswerStreams((runId) => emit(runId));
	function persisted(runId: string): RunProgress | null {
		const run = store.read((db) => byId(db, runId));
		if (!run) return null;
		// Stored history remains adoption-only. Live progress overlays the current in-memory generation.
		const answer =
			run.status === "completed" && run.answerMessageId
				? conversation.message(run.answerMessageId)
				: null;
		return {
			runId,
			status: run.status,
			text: answer?.conversationId === run.conversationId ? answer.text : "",
			provisional: null,
			announcement: run.announcement ?? null,
			error: run.status === "failed" ? run.error : null,
		};
	}
	function withStream(value: RunProgress): RunProgress {
		const live =
			value.status === "running" ? streams.current(value.runId) : undefined;
		return live
			? {
					...value,
					text: live.text,
					provisional: {
						generationId: live.generationId,
						sequence: live.sequence,
					},
				}
			: value;
	}
	function progress(runId: string) {
		const value = persisted(runId);
		return value ? withStream(value) : null;
	}
	function emit(runId: string) {
		const base = watched.get(runId);
		if (!base) return;
		const value = withStream(base);
		for (const listener of watchers.get(runId) ?? []) {
			try {
				listener(value);
			} catch {
				/* Isolated observers. */
			}
		}
	}
	function publish(runId: string) {
		if (!watchers.has(runId)) return;
		const value = persisted(runId) ?? {
			runId,
			status: "cancelled" as const,
			text: "",
			provisional: null,
			announcement: null,
			error: null,
		};
		watched.set(runId, value);
		emit(runId);
	}
	const stopCommits = store.onCommit(() => {
		for (const id of streams.runIds()) {
			const run = store.read((db) => byId(db, id));
			if (run?.status === "running" || run?.status === "queued") continue;
			// Retirement notifies synchronously: expose the committed state before removing the draft.
			if (watchers.has(id)) {
				const value = persisted(id);
				if (value) watched.set(id, value);
			}
			streams.retire(
				id,
				run?.status === "completed"
					? undefined
					: new Error(run?.error ?? "generation_cancelled"),
			);
		}
		for (const id of watchers.keys()) {
			const value = persisted(id);
			const previous = watched.get(id);
			if (
				!value ||
				value.status !== previous?.status ||
				value.text !== previous.text ||
				value.announcement !== previous.announcement ||
				value.error !== previous.error
			)
				publish(id);
		}
	});
	return {
		openAnswerStream: streams.open,
		subscribeAnswerStream: streams.subscribe,
		progress,
		publish,
		subscribeProgress(runId: string, listener: (value: RunProgress) => void) {
			let set = watchers.get(runId);
			if (!set) {
				set = new Set();
				watchers.set(runId, set);
			}
			set.add(listener);
			const stop = () => {
				set!.delete(listener);
				if (!set!.size && watchers.get(runId) === set) {
					watchers.delete(runId);
					watched.delete(runId);
				}
			};
			try {
				const value = persisted(runId);
				if (value) {
					watched.set(runId, value);
					listener(withStream(value));
				}
			} catch (error) {
				stop();
				throw error;
			}
			return stop;
		},
		close() {
			stopCommits();
			streams.close();
			watchers.clear();
			watched.clear();
		},
	};
}
export type Progress = ReturnType<typeof createProgress>;
