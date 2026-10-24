import { byId } from "../repository";
import type { RunProgress } from "../contracts";
import type { DialogueDeps } from "./context";

/** Progress watchers and their commit-driven refresh. */
export function createProgress(deps: DialogueDeps) {
	const { store, conversation } = deps;
	const watchers = new Map<string, Set<(value: RunProgress) => void>>();
	const watchedStatuses = new Map<string, string>();
	function progress(runId: string): RunProgress | null {
		const run = store.read((db) => byId(db, runId));
		if (!run) return null;
		// The one place body text leaves this domain (SSE, subscribers, voice).
		// The adoption receipt is the completed run with its answer message,
		// written in the settle transaction; nothing else releases a body.
		const answer =
			run.status === "completed" && run.answerMessageId
				? conversation
						.get(run.conversationId)
						.messages.find((m) => m.id === run.answerMessageId)?.text
				: null;
		return {
			runId,
			status: run.status,
			text: answer ?? "",
			announcement: run.announcement ?? null,
			error: run.status === "failed" ? run.error : null,
		};
	}
	function publish(runId: string) {
		const value = progress(runId);
		if (!value) return;
		watchedStatuses.set(runId, value.status);
		for (const listener of watchers.get(runId) ?? []) {
			try {
				listener(value);
			} catch {
				/* Isolated observers. */
			}
		}
	}
	const stopCommits = store.onCommit(() => {
		for (const id of watchers.keys()) {
			const status = store.read((db) => byId(db, id))?.status;
			if (status !== watchedStatuses.get(id)) publish(id);
		}
	});
	return {
		progress,
		publish,
		subscribeProgress(runId: string, listener: (value: RunProgress) => void) {
			let set = watchers.get(runId);
			if (!set) {
				set = new Set();
				watchers.set(runId, set);
			}
			set.add(listener);
			const value = progress(runId);
			if (value) {
				watchedStatuses.set(runId, value.status);
				listener(value);
			}
			return () => {
				set!.delete(listener);
				if (!set!.size) {
					watchers.delete(runId);
					watchedStatuses.delete(runId);
				}
			};
		},
		close() {
			stopCommits();
			watchers.clear();
			watchedStatuses.clear();
		},
	};
}
export type Progress = ReturnType<typeof createProgress>;
