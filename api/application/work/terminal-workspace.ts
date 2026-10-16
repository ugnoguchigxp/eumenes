import type { SqliteStore } from "../../infrastructure/sqlite";
import {
	readWorkspaceGuard,
	reserveWorkspaceInTransaction,
	beginWorkspaceReleaseInTransaction,
} from "../../domains/kanban";
import type {
	TerminalWorkspaceIdentity,
	TerminalWorkspacePort,
	TerminalsService,
} from "../../domains/terminals";

const owner = (identity: TerminalWorkspaceIdentity) =>
	identity.owner === "direct" ? `direct:${identity.sessionId}` : identity.owner;
/** Physical cwd registration is host data, not a path the UI or model supplies. */
export function createTerminalWorkspacePort(options: {
	store: SqliteStore;
	executorId: string;
	workspaceRef: (cwd: string | undefined) => string | null;
}): TerminalWorkspacePort {
	function ref(identity: TerminalWorkspaceIdentity) {
		const value = options.workspaceRef(identity.cwd);
		if (!value) throw new Error("terminal_workspace_unregistered");
		return value;
	}
	const allowed = (identity: TerminalWorkspaceIdentity) =>
		options.store.readSnapshot((tx) => {
			const guard = readWorkspaceGuard(tx, ref(identity));
			return (
				!!guard &&
				guard.state === "held" &&
				guard.ownerRef === owner(identity) &&
				guard.executorId === options.executorId
			);
		});
	return {
		reserveDirect: (identity) =>
			options.store.write((tx) => {
				const workspaceRef = ref(identity);
				const held = readWorkspaceGuard(tx, workspaceRef);
				if (
					!reserveWorkspaceInTransaction(tx, {
						workspaceRef,
						ownerRef: owner(identity),
						executorId: options.executorId,
						epoch: held?.epoch ?? crypto.randomUUID(),
						state: "held",
					})
				)
					throw new Error("terminal_workspace_busy");
			}),
		assertLaunch: (identity) => {
			if (!allowed(identity)) throw new Error("terminal_workspace_busy");
		},
		assertInput: async (identity) => {
			if (!allowed(identity)) throw new Error("terminal_workspace_releasing");
		},
		reserveSending: (tx, identity) => {
			const workspaceRef = ref(identity);
			const held = readWorkspaceGuard(tx, workspaceRef);
			return reserveWorkspaceInTransaction(tx, {
				workspaceRef,
				ownerRef: owner(identity),
				executorId: options.executorId,
				epoch: held?.epoch ?? crypto.randomUUID(),
				state: "held",
			});
		},
	};
}

/** Reserve release in the writer. The actual PTY termination is a separate awaited operation. */
export function createIdleTerminalHandoff(options: {
	store: SqliteStore;
	terminals: TerminalsService;
	workspaceRef: (cwd: string | undefined) => string | null;
}) {
	return {
		async begin(sessionId: string) {
			const reserved = await options.store.write((tx) => {
				const session = options.terminals
					.workspaceSessions()
					.find((entry) => entry.sessionId === sessionId);
				if (
					!session ||
					session.owner === "direct" ||
					session.activity !== "idle" ||
					session.inflight ||
					session.closing ||
					session.pendingInput ||
					session.manualInputSeen
				)
					return null;
				const ref = options.workspaceRef(session.cwd);
				if (!ref) return null;
				const guard = readWorkspaceGuard(tx, ref);
				if (
					!guard ||
					guard.ownerRef !== owner(session) ||
					!beginWorkspaceReleaseInTransaction(tx, guard)
				)
					return null;
				return { guard, sessionId: session.sessionId, run: session.run };
			});
			if (!reserved) return null;
			const managedStopped = await options.terminals.closeIdleForHandoff(
				reserved.sessionId,
			);
			// PTY exit does not certify arbitrary background descendants. Handoff policy decides release.
			return { ...reserved, managedStopped };
		},
	};
}
