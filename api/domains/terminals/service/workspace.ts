import { getLogger } from "../../../infrastructure/logger";
import type {
	Runtime,
	Session,
	TerminalSize,
	TerminalWorkspaceIdentity,
} from "./types";
import { sessionView, workspaceIdentity, type Sessions } from "./sessions";

const log = getLogger("terminals");

/** A launch failed or an exit was observed. Check for a new run again in the writer. */
export async function releaseDirectWorkspace(
	rt: Runtime,
	identity: TerminalWorkspaceIdentity,
	session = rt.sessions.get(identity.sessionId),
) {
	if (identity.owner !== "direct") return;
	try {
		await rt.options.workspace?.releaseDirect(identity, () => {
			const current = rt.sessions.get(identity.sessionId) ?? session;
			return current?.status !== "running";
		});
	} catch {
		log.warn("terminals.workspace_release_failed", {
			sessionId: identity.sessionId,
		});
	}
}

/** Authorization is awaited before PTY IO; pending input also prevents an idle handoff. */
export function createWorkspaceSessions(rt: Runtime, sessions: Sessions) {
	async function launch(
		identity: TerminalWorkspaceIdentity,
		start: () => Session,
		existing?: Session,
	) {
		await rt.options.workspace?.reserveDirect(identity);
		try {
			return sessionView(start());
		} catch (error) {
			await releaseDirectWorkspace(rt, identity, existing);
			throw error;
		}
	}

	return {
		async startGuarded(request: { title?: string } & TerminalSize) {
			if (!rt.command) throw new Error("terminal_unavailable");
			const id = crypto.randomUUID();
			return launch(
				{ sessionId: id, owner: "direct", cwd: rt.options.cwd, run: 1 },
				() => sessions.open(request, id),
			);
		},
		async restartGuarded(id: string, size: TerminalSize) {
			const session = sessions.find(id);
			return launch(
				workspaceIdentity(session, session.run + 1),
				() => sessions.restart(id, size),
				session,
			);
		},
		async inputGuarded(id: string, data: string) {
			const session = sessions.find(id);
			if (!sessions.isLive(session) || session.closing)
				throw new Error("terminal_not_running");
			const pty = session.pty;
			const run = session.run;
			session.pendingManualInputs++;
			try {
				await rt.options.workspace?.assertInput(workspaceIdentity(session));
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
					...workspaceIdentity(session),
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
