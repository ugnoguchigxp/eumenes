import type { Runtime, TerminalSize, TerminalWorkspaceIdentity } from "./types";
import { sessionView, type Sessions } from "./sessions";
import type { Session } from "./types";

const identity = (session: Session): TerminalWorkspaceIdentity => ({
	sessionId: session.id,
	owner: session.owner,
	cwd: session.cwd,
	run: session.run,
});
/** Authorization is awaited before PTY IO; pending input also prevents an idle handoff. */
export function createWorkspaceSessions(rt: Runtime, sessions: Sessions) {
	return {
		async startGuarded(request: { title?: string } & TerminalSize) {
			if (!rt.command) throw new Error("terminal_unavailable");
			const id = crypto.randomUUID();
			await rt.options.workspace?.reserveDirect({
				sessionId: id,
				owner: "direct",
				cwd: rt.options.cwd,
				run: 1,
			});
			return sessionView(sessions.open(request, id));
		},
		async restartGuarded(id: string, size: TerminalSize) {
			const session = sessions.find(id);
			await rt.options.workspace?.reserveDirect({
				...identity(session),
				run: session.run + 1,
			});
			return sessionView(sessions.restart(id, size));
		},
		async inputGuarded(id: string, data: string) {
			const session = sessions.find(id);
			if (!sessions.isLive(session) || session.closing)
				throw new Error("terminal_not_running");
			const pty = session.pty;
			const run = session.run;
			session.pendingManualInputs++;
			try {
				await rt.options.workspace?.assertInput(identity(session));
				if (session.pty !== pty || session.run !== run || session.closing)
					throw new Error("terminal_workspace_releasing");
				sessions.input(id, data);
			} finally {
				session.pendingManualInputs--;
			}
		},
		workspaceSessions: () =>
			sessions
				.all()
				.filter(sessions.isLive)
				.map((session) => ({
					...identity(session),
					activity: session.activity,
					inflight: !!session.inflight,
					closing: session.closing,
					pendingInput: session.pendingManualInputs > 0,
					manualInputSeen: session.manualInputSeen,
				})),
		async closeIdleForHandoff(id: string) {
			const session = sessions.find(id);
			if (
				session.owner === "direct" ||
				session.activity !== "idle" ||
				session.inflight ||
				session.closing ||
				session.pendingManualInputs > 0 ||
				session.manualInputSeen ||
				!sessions.isLive(session)
			)
				return false;
			session.closing = true;
			return sessions.terminate(session);
		},
	};
}
