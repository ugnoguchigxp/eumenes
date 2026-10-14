import { getLogger } from "../../infrastructure/logger";
import type { Ledger } from "./ledger";
import * as repository from "./repository";
import type { RequestRow } from "./repository";
import { createEntry, DEFAULT_TERMINAL_SIZE, type Sessions } from "./sessions";
import type { Inflight, Runtime, Session } from "./types";

const log = getLogger("terminals");

type Plan =
	| { kind: "wait" }
	| { kind: "paste"; session: Session }
	| { kind: "launch"; reuse?: Session };
const WAIT: Plan = { kind: "wait" };

/**
 * The sender. It reads the saved queue and sends a request only when Claude Code can take it:
 * at most one request per PTY, the hooks reported (SessionStart), nothing running or asked, the
 * person not typing, and Kanban's single-run rule. It writes `sending` before it touches a PTY
 * and `delivered` after, and never sends the same request twice.
 */
export function createDispatcher(
	rt: Runtime,
	ledger: Ledger,
	sessions: Sessions,
) {
	const manualInputWaitMs = rt.options.manualInputWaitMs ?? 3000;
	let active = false;
	let current: Promise<void> = Promise.resolve();
	let again = false;

	/** Kanban runs one task at a time: no other Kanban run in flight or at work. */
	function groupBusy(row: RequestRow) {
		if (row.exclusiveGroup !== "kanban") return false;
		return sessions
			.all()
			.some(
				(s) =>
					(sessions.isLive(s) &&
						s.owner.startsWith("kanban:") &&
						(s.activity === "working" || s.activity === "waiting")) ||
					s.inflight?.exclusiveGroup === "kanban",
			);
	}

	const canPaste = (s: Session) =>
		sessions.isLive(s) &&
		!s.closing &&
		s.sessionStarted &&
		s.activity === "idle" &&
		!s.inflight &&
		rt.now() - s.lastInputAtMs >= manualInputWaitMs;

	/** A launch needs a free slot; otherwise the least recently used idle Kanban session makes room. */
	function slotFree(): boolean {
		if (sessions.liveCount() < rt.limit) return true;
		if (!sessions.all().some((s) => s.closing)) {
			const victim = sessions.evictable();
			if (victim) sessions.close(victim);
		}
		return false;
	}

	function plan(row: RequestRow): Plan {
		if (groupBusy(row)) return WAIT;
		const list = sessions.all();
		if (row.target === "conversation") {
			const live = list.find(
				(s) => sessions.isLive(s) && s.claudeSessionId === row.claudeSessionId,
			);
			if (live) {
				if (live.closing) return WAIT;
				if (live.mode !== row.mode) {
					// Settings are fixed per run: the other mode needs a new run once this one is idle.
					if (canPaste(live)) sessions.close(live);
					return WAIT;
				}
				return canPaste(live) ? { kind: "paste", session: live } : WAIT;
			}
			return slotFree() ? { kind: "launch" } : WAIT;
		}
		if (row.target === "current") {
			const live = list
				.filter((s) => sessions.isLive(s) && !s.closing && s.owner === "direct")
				.at(-1);
			if (live) {
				if (live.sessionStarted)
					return canPaste(live) ? { kind: "paste", session: live } : WAIT;
				// Still starting: give it the time a run needs to report.
				if (rt.now() - live.startedAtMs < sessions.trackingMs) return WAIT;
			}
			// The pane of an ended run is used again, so the screen keeps one pane.
			const last = list.at(-1);
			const reuse =
				last && last.owner === "direct" && last.status === "exited"
					? last
					: undefined;
			return slotFree() ? { kind: "launch", reuse } : WAIT;
		}
		return slotFree() ? { kind: "launch" } : WAIT;
	}

	async function fail(row: RequestRow, session?: Session) {
		try {
			await ledger.finalize(
				row.id,
				{ state: "cancelled", reason: "send_failed" },
				session,
			);
		} catch {
			log.warn("terminals.finish_save_failed", { attemptId: row.id });
		}
	}

	async function execute(
		row: RequestRow,
		chosen: Plan & { kind: "paste" | "launch" },
	) {
		const flight: Inflight = {
			id: row.id,
			phase: "sending",
			prompt: row.prompt,
			task: row.task,
			owner: row.owner,
			...(row.exclusiveGroup ? { exclusiveGroup: row.exclusiveGroup } : {}),
			files: [],
			waitNotified: false,
		};
		let session: Session;
		if (chosen.kind === "paste") {
			session = chosen.session;
			session.inflight = flight;
			let moved = false;
			try {
				moved = await ledger.markSending(row.id, session.id, session.run);
			} finally {
				if (!moved && session.inflight === flight) delete session.inflight;
			}
			if (!moved) return;
			try {
				if (!sessions.isLive(session)) throw new Error("terminal_not_running");
				sessions.paste(session, row.prompt);
			} catch {
				await fail(row, session);
				return;
			}
		} else {
			const project = rt.projects(row.projectId);
			const reuse = chosen.reuse;
			const entry =
				reuse ??
				createEntry({
					title: row.owner === "direct" ? sessions.nextTitle() : row.task,
					owner: row.owner,
					mode: row.mode,
					cwd: project?.cwd,
				});
			const moved = await ledger.markSending(row.id, entry.id, entry.run + 1);
			if (!moved) return;
			if (!project) return fail(row);
			entry.owner = row.owner;
			entry.mode = row.mode;
			entry.cwd = project.cwd;
			try {
				sessions.launch(entry, {
					size: reuse?.size ?? DEFAULT_TERMINAL_SIZE,
					claude: {
						resume: row.target === "conversation",
						id: row.claudeSessionId ?? crypto.randomUUID(),
					},
					prompt: row.prompt,
					inflight: flight,
				});
			} catch {
				return fail(row);
			}
			if (!reuse) rt.sessions.set(entry.id, entry);
			session = entry;
		}
		session.lastUsedAtMs = rt.now();
		if (flight.phase === "sending") flight.phase = "delivered";
		if (row.owner === "direct") rt.sent += 1;
		rt.changed();
		try {
			await ledger.markDelivered(row.id);
		} catch {
			// Recovery marks a `sending` request unknown; the run itself is not affected.
			log.warn("terminals.delivered_save_failed", { attemptId: row.id });
		}
		// The run may have ended while the state was being saved.
		if (session.inflight === flight && !sessions.isLive(session))
			try {
				await ledger.finalize(
					row.id,
					{ state: "ended", reason: "session_ended" },
					session,
				);
			} catch {
				log.warn("terminals.finish_save_failed", { attemptId: row.id });
			}
	}

	async function pass() {
		const store = rt.options.store;
		if (!store) return;
		for (const row of store.read((db) => repository.queued(db))) {
			const chosen = plan(row);
			if (chosen.kind === "wait") continue;
			try {
				await execute(row, chosen);
			} catch (error) {
				log.warn("terminals.dispatch_failed", {
					attemptId: row.id,
					reason: error instanceof Error ? error.message : "error",
				});
			}
		}
	}

	/** One pass after another until a kick arrives with nothing new to look at. */
	async function loop() {
		const store = rt.options.store!;
		try {
			do {
				again = false;
				try {
					// Nothing queued is the common case on every commit of the whole system.
					if (store.read((db) => repository.hasQueued(db))) await pass();
				} catch (error) {
					if (!(error instanceof Error && error.message === "database_closing"))
						log.warn(
							"terminals.dispatch_failed",
							{ reason: "pass_failed" },
							error,
						);
				}
			} while (again);
		} finally {
			active = false;
		}
	}

	function kick() {
		if (!rt.options.store) return;
		if (active) {
			again = true;
			return;
		}
		active = true;
		current = loop();
	}

	return {
		kick,
		/** Resolves once the sender has nothing more to do right now. */
		async settled() {
			while (active) await current;
		},
	};
}
