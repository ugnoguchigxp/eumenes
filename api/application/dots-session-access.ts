import type { Database } from "bun:sqlite";
import type { createInbox, NativeSession } from "../domains/dots";
import type { OrchestrationWorkTask, TasksService } from "../domains/tasks";
/** A native session may be reused only by explicit grant, under the same owner/project, without concurrent work. */
export function assertDotsSessionAccess(
	db: Database,
	t: OrchestrationWorkTask,
	ports: {
		tasks: () => TasksService;
		inbox: ReturnType<typeof createInbox>;
	},
	incoming: NativeSession[] = [],
	cleanup = false,
) {
	const { tasks, inbox } = ports;
	const known = inbox.sessionsInTransaction(db, t.id);
	const refs = new Set([
		...known.map((s) => s.threadId),
		...(cleanup ? [] : t.grant.sessionRefs),
		...incoming.map((s) => s.threadId),
	]);
	for (const ref of refs) {
		const associations = inbox
			.sessionAssociationsInTransaction(db, ref)
			.filter((s) => s.taskId !== t.id);
		if (
			!cleanup &&
			associations.length &&
			!known.some((s) => s.threadId === ref) &&
			(!t.grant.sessionRefs.includes(ref) ||
				!t.grant.operations.includes("continue_session"))
		)
			throw new Error("dots_permission_denied");
		for (const a of associations) {
			const owner = tasks().getInTransaction(db, a.taskId);
			if (
				!owner ||
				owner.kind !== "orchestration" ||
				owner.grant.connectionRef !== t.grant.connectionRef ||
				owner.grant.projectRef !== t.grant.projectRef
			)
				throw new Error("dots_permission_denied");
			const s = incoming.find((s) => s.threadId === ref);
			if (s && JSON.stringify(a.session) !== JSON.stringify(s))
				throw new Error("dots_conflict");
		}
	}
	for (const other of tasks().liveInTransaction(db)) {
		if (
			other.id === t.id ||
			other.kind !== "orchestration" ||
			["registered", "paused"].includes(other.state)
		)
			continue;
		if (
			[
				...other.grant.sessionRefs,
				...inbox.sessionsInTransaction(db, other.id).map((s) => s.threadId),
			].some((ref) => refs.has(ref))
		)
			throw new Error("dots_conflict");
	}
}
