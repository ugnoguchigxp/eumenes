import { getLogger } from "../../infrastructure/logger";
import {
	editedPath,
	type HookPayload,
	LAST_MESSAGE_CHARS,
	waitsForPerson,
} from "./hooks";
import type { Ledger } from "./ledger";
import { addFile, projectRelative, sameTurn } from "./requests";
import type { Inflight, Runtime, Session } from "./types";

const log = getLogger("terminals");

/**
 * What one Claude Code hook of a run means. Requests are tied to turns by `prompt_id` (the
 * `UserPromptSubmit`, tool uses, notifications and `Stop` of one turn share it), never to
 * "whatever is current", so a late or repeated hook of an earlier turn changes nothing.
 * Throws when a final state could not be saved; the hook is then answered with 503.
 */
export function createHookEvents(
	rt: Runtime,
	ledger: Ledger,
	trackingLost: (session: Session) => void,
) {
	/** The request this hook belongs to: by prompt_id, or the started one when the hook has none. */
	function boundTo(
		session: Session,
		payload: HookPayload,
	): Inflight | undefined {
		const flight = session.inflight;
		if (!flight || flight.phase !== "started") return undefined;
		return payload.prompt_id === undefined ||
			payload.prompt_id === flight.promptId
			? flight
			: undefined;
	}

	async function onPrompt(session: Session, payload: HookPayload) {
		session.activity = "working";
		rt.changed();
		const flight = session.inflight;
		if (!session.promptChecked) {
			session.promptChecked = true;
			// Without a prompt_id no turn can be told from another: the run cannot be tracked.
			if (!payload.prompt_id && flight) return trackingLost(session);
		}
		const promptId = payload.prompt_id;
		if (!promptId || !flight) return;
		if (flight.phase === "started") {
			// Another turn began without a Stop of this one (interrupted with Esc).
			if (flight.promptId !== promptId)
				await ledger.finalize(flight.id, { state: "interrupted" }, session);
			return;
		}
		// The turn of the request that was sent; anything else is the person's own turn.
		if (
			payload.prompt !== undefined &&
			sameTurn(payload.prompt, flight.prompt)
		) {
			flight.phase = "started";
			flight.promptId = promptId;
			try {
				await ledger.markStarted(flight.id, promptId);
			} catch {
				// The final state is written from any open state, so this one is not needed.
				log.warn("terminals.start_save_failed", { attemptId: flight.id });
			}
		}
	}

	return async function apply(session: Session, payload: HookPayload) {
		await ledger.retryUnsaved();
		// A hook of another conversation (a stale file, a copy) does not belong to this run.
		if (payload.session_id !== session.claudeSessionId) return;
		switch (payload.hook_event_name) {
			case "SessionStart":
				session.sessionStarted = true;
				clearTimeout(session.trackingTimer);
				rt.changed();
				rt.kick();
				return;
			case "UserPromptSubmit":
				return onPrompt(session, payload);
			case "PostToolUse": {
				// Work goes on after the person answered a permission question.
				if (session.activity === "waiting") {
					session.activity = "working";
					rt.changed();
				}
				const flight = boundTo(session, payload);
				const path = editedPath(payload);
				const relative =
					flight && path && session.cwd
						? projectRelative(session.cwd, path)
						: undefined;
				if (flight && relative) addFile(flight.files, relative);
				return;
			}
			case "Notification": {
				if (!waitsForPerson(payload)) return;
				session.activity = "waiting";
				rt.changed();
				const flight = boundTo(session, payload);
				if (flight && !flight.waitNotified) {
					flight.waitNotified = true;
					try {
						await ledger.notifyWaiting(flight);
					} catch {
						flight.waitNotified = false;
						log.warn("terminals.waiting_save_failed", { attemptId: flight.id });
					}
				}
				return;
			}
			case "Stop": {
				session.activity = "idle";
				session.lastUsedAtMs = rt.now();
				rt.changed();
				const flight = session.inflight;
				try {
					if (
						flight?.phase === "started" &&
						payload.prompt_id !== undefined &&
						payload.prompt_id === flight.promptId
					)
						await ledger.finalize(
							flight.id,
							{
								state: "completed",
								report: (payload.last_assistant_message ?? "").slice(
									0,
									LAST_MESSAGE_CHARS,
								),
							},
							session,
						);
				} finally {
					rt.kick();
				}
				return;
			}
		}
	};
}
