import type { Database } from "bun:sqlite";
import {
	reserveWorkspaceInTransaction,
	readWorkspaceGuard,
	type KanbanDispatch,
	type KanbanExecutor,
	type KanbanService,
	type KanbanGitGrant,
} from "../../domains/kanban";
import type { KanbanGitPreview, KanbanGitRequest } from "./codex-task-git";

export type KanbanExecutorPort = {
	definition: () => KanbanExecutor;
	enqueueInTransaction: (
		tx: Database,
		dispatch: KanbanDispatch,
		guardEpoch: string,
	) => void;
	cancelQueuedInTransaction: (tx: Database, runId: string) => boolean;
	stop: (runId: string) => Promise<"confirmed" | "unconfirmed">;
	gitPreviewInTransaction?: (
		tx: Database,
		cardId: string,
	) => KanbanGitPreview | null;
	gitGrantInTransaction?: (
		tx: Database,
		input: KanbanGitRequest,
		mode: KanbanGitGrant["mode"],
		id: string,
	) => KanbanGitGrant;
};

/** One registration table connects execution mechanics; queue decisions remain in kanban. */
export function createKanbanExecutorRegistry(
	ports: readonly KanbanExecutorPort[],
) {
	const entries = new Map<string, KanbanExecutorPort>();
	for (const port of ports) {
		const id = port.definition().id;
		if (entries.has(id)) throw new Error("kanban_executor_duplicate");
		entries.set(id, port);
	}
	return {
		definitions: () => [...entries.values()].map((port) => port.definition()),
		port: (id: string) => entries.get(id),
		enqueueInTransaction(
			tx: Database,
			kanban: KanbanService,
			dispatch: KanbanDispatch,
		): boolean {
			const port = entries.get(dispatch.executorId);
			const definition = port?.definition();
			if (
				!port ||
				!definition?.available ||
				definition.revision !== dispatch.executorRevision ||
				definition.workspaceRef !== dispatch.workspaceRef
			)
				throw new Error("kanban_executor_unavailable");
			const ownerRef = `kanban:${dispatch.cardId}`;
			const held = readWorkspaceGuard(tx, dispatch.workspaceRef);
			const epoch = held?.epoch ?? dispatch.runId;
			if (
				!reserveWorkspaceInTransaction(tx, {
					workspaceRef: dispatch.workspaceRef,
					ownerRef,
					executorId: dispatch.executorId,
					epoch,
					state: "held",
				})
			) {
				kanban.deferDispatchInTransaction(tx, dispatch.runId);
				return false;
			}
			port.enqueueInTransaction(tx, dispatch, epoch);
			return true;
		},
	};
}
