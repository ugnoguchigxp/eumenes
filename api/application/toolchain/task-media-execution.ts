import type { Database } from "bun:sqlite";
import type { ChildExecution, ChildResult } from "../../domains/tool-runtime";

export type TaskMediaPorts = {
	purgeCallInTransaction(db: Database, id: string): void;
	available(kind: "image" | "music" | "excalidraw"): boolean;
	startInTransaction(
		db: Database,
		child: ChildExecution,
		kind: "image" | "music-create" | "music-playback" | "excalidraw",
	): ChildResult;
	currentInTransaction(
		db: Database,
		child: ChildExecution,
		ref: unknown,
	): ChildResult;
	cancelInTransaction(db: Database, child: ChildExecution, ref: unknown): void;
};
type Media = {
	purgeCallInTransaction(db: Database, id: string): void;
	startInTransaction(
		db: Database,
		input: {
			runId: string;
			conversationId: string;
			question: string;
			originalRequest: string;
			deadline: number;
			execution?: ChildExecution;
		},
	): { id: string; jobId: string };
	resultForCallInTransaction(db: Database, id: string): unknown;
	cancelCallInTransaction(db: Database, id: string): void;
};
export function taskMediaPorts(media: {
	image?: Media;
	music?: Media & {
		playback: Media;
		startPlaybackInTransaction: Media["startInTransaction"];
	};
	excalidraw?: Media;
}): TaskMediaPorts {
	const target = (kind: string) =>
		kind === "image"
			? media.image
			: kind === "excalidraw"
				? media.excalidraw
				: kind === "music-playback"
					? media.music?.playback
					: media.music;
	function currentInTransaction(
		db: Database,
		child: ChildExecution,
		raw: unknown,
	): ChildResult {
		const ref = raw as { kind: "media"; type: string; id: string };
		const view = target(ref.type)?.resultForCallInTransaction(db, ref.id) as {
			state: string;
			errorCode?: string;
			action?: string;
		} | null;
		const state = !view
			? "cancelled"
			: ["failed", "cancelled"].includes(view.state)
				? (view.state as "failed" | "cancelled")
				: view.state === "completed"
					? "completed"
					: "running";
		return {
			state,
			ref,
			output: view,
			summary: JSON.stringify(
				view ?? { errorCode: "generation_missing" },
			).slice(0, 2000),
			modelCalls: (child.usedModelCalls ?? 0) + 1,
			references: [],
			...(view?.errorCode ? { code: view.errorCode } : {}),
		};
	}
	return {
		purgeCallInTransaction(db, id) {
			for (const service of [
				media.image,
				media.music,
				media.music?.playback,
				media.excalidraw,
			])
				service?.purgeCallInTransaction(db, id);
		},
		available: (kind) => !!target(kind),
		startInTransaction(db, child, kind) {
			const service = target(kind);
			if (!service || child.modelCalls < 1)
				throw new Error("capability_unavailable");
			const start =
				kind === "music-playback"
					? media.music!.startPlaybackInTransaction
					: service.startInTransaction;
			const started = start(db, {
				runId: child.source.runId,
				conversationId: child.source.conversationId,
				question: child.request,
				originalRequest: child.source.request,
				deadline: child.deadline,
				execution: child,
			});
			return currentInTransaction(db, child, {
				kind: "media",
				type: kind,
				id: started.id,
			});
		},
		currentInTransaction,
		cancelInTransaction(db, child, raw) {
			if (raw) {
				const ref = raw as { type: string; id: string };
				target(ref.type)?.cancelCallInTransaction(db, ref.id);
			} else
				for (const service of [
					media.image,
					media.music,
					media.music?.playback,
					media.excalidraw,
				])
					service?.cancelCallInTransaction(db, child.id);
		},
	};
}
