import { uptime } from "node:os";
import type { SqliteStore } from "../../infrastructure/sqlite";
import { getLogger } from "../../infrastructure/logger";
import {
	readWorkspaceGuard,
	readWorkspaceGuards,
	reserveWorkspaceInTransaction,
	beginWorkspaceReleaseInTransaction,
	finishWorkspaceReleaseInTransaction,
} from "../../domains/kanban";
import {
	latestDirectTerminalActivityInTransaction,
	type TerminalWorkspaceIdentity,
	type TerminalWorkspacePort,
	type TerminalsService,
} from "../../domains/terminals";

const log = getLogger("terminals");

const owner = (identity: TerminalWorkspaceIdentity) =>
	identity.owner === "direct" ? `direct:${identity.sessionId}` : identity.owner;

/** Run at startup. A direct PTY's ID is local to the backend that created it. */
async function recoverDirectTerminalWorkspace(
	store: SqliteStore,
	workspaceRef: string,
	hostBootedAtMs: number,
) {
	const released = await store.write((tx) => {
		const guard = readWorkspaceGuards(tx, workspaceRef).find(
			(holder) =>
				holder.executorId === "claude-code" &&
				holder.mode === "exclusive" &&
				holder.ownerRef.startsWith("direct:"),
		);
		if (guard?.state !== "held") return;
		const sessionId = guard.ownerRef.slice("direct:".length);
		const observedAt = latestDirectTerminalActivityInTransaction(
			tx,
			sessionId,
			workspaceRef,
		);
		// The OS reboot ended the backend and its in-memory PTY. A server restart
		// on the same OS boot, or missing session evidence, does not prove an exit.
		if (!observedAt || !(Date.parse(observedAt) < hostBootedAtMs)) return;
		if (
			beginWorkspaceReleaseInTransaction(tx, guard) &&
			finishWorkspaceReleaseInTransaction(tx, guard, true)
		)
			return sessionId;
	});
	if (released)
		log.info("terminals.workspace_recovered", {
			sessionId: released,
			reason: "host_reboot_confirmed",
		});
}

/** Physical cwd registration is host data, not a path the UI or model supplies. */
export function createTerminalWorkspacePort(options: {
	store: SqliteStore;
	executorId: string;
	workspaceRef: (cwd: string | undefined) => string | null;
	hostBootedAtMs?: number;
}): TerminalWorkspacePort {
	function ref(identity: TerminalWorkspaceIdentity) {
		const value = options.workspaceRef(identity.cwd);
		if (!value) throw new Error("terminal_workspace_unregistered");
		return value;
	}
	const allowed = (identity: TerminalWorkspaceIdentity) =>
		options.store.readSnapshot((tx) => {
			const guards = readWorkspaceGuards(tx, ref(identity));
			const guard = guards[0];
			return (
				guards.length === 1 &&
				!!guard &&
				guard.mode === "exclusive" &&
				guard.state === "held" &&
				guard.ownerRef === owner(identity) &&
				guard.executorId === options.executorId
			);
		});
	return {
		async recoverDirect(cwd) {
			const workspaceRef = options.workspaceRef(cwd);
			if (!workspaceRef || options.executorId !== "claude-code") return;
			// Leave one second for the host uptime's whole-second precision.
			const hostBootedAtMs =
				options.hostBootedAtMs ?? Date.now() - (uptime() + 1) * 1000;
			await recoverDirectTerminalWorkspace(
				options.store,
				workspaceRef,
				hostBootedAtMs,
			);
		},
		reserveDirect: (identity) =>
			options.store.write((tx) => {
				const workspaceRef = ref(identity);
				const held = readWorkspaceGuard(tx, workspaceRef, {
					ownerRef: owner(identity),
					executorId: options.executorId,
				});
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
		releaseDirect: (identity, isInactive) =>
			options.store.write(
				(tx) => {
					if (identity.owner !== "direct" || !isInactive()) return;
					const guard = readWorkspaceGuard(tx, ref(identity), {
						ownerRef: owner(identity),
						executorId: options.executorId,
					});
					if (
						guard?.ownerRef === owner(identity) &&
						guard.executorId === options.executorId &&
						beginWorkspaceReleaseInTransaction(tx, guard)
					)
						finishWorkspaceReleaseInTransaction(tx, guard, true);
				},
				{ reserved: true },
			),
		assertLaunch: (identity) => {
			if (!allowed(identity)) throw new Error("terminal_workspace_busy");
		},
		assertInput: async (identity) => {
			if (!allowed(identity)) throw new Error("terminal_workspace_releasing");
		},
		reserveSending: (tx, identity) => {
			const workspaceRef = ref(identity);
			const held = readWorkspaceGuard(tx, workspaceRef, {
				ownerRef: owner(identity),
				executorId: options.executorId,
			});
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
				const guard = readWorkspaceGuard(tx, ref, {
					ownerRef: owner(session),
					executorId: "claude-code",
				});
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
