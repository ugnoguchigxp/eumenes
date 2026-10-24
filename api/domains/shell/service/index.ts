import type { Database } from "bun:sqlite";
import { getLogger } from "../../../infrastructure/logger";
import {
	isFinal,
	type EnqueueRun,
	type ShellRun,
	type RunFinished,
} from "../contracts";
import * as repository from "../repository";
import { createLedger } from "./ledger";
import { createSessions } from "./sessions";
import type { ShellOptions, Session } from "./types";

const log = getLogger("shell");
export function createShell(input: ShellOptions = {}) {
	const options: ShellOptions = {
		...input,
		cwd: input.cwd ?? process.cwd(),
		projects:
			input.projects ??
			((id) => (id === "eumenes" ? { cwd: input.cwd ?? process.cwd() } : null)),
	};
	const shell =
		options.shell === undefined
			? Bun.which(process.env.SHELL || "/bin/sh")
			: options.shell;
	const now = () => (options.now?.() ?? new Date()).toISOString();
	let revision = 0,
		recovered = false,
		closed = false,
		busy: Promise<void> | undefined;
	const changed = () => {
		revision++;
		options.onChange?.();
	};
	const sessions = createSessions(options, shell, changed);
	const ledger = createLedger(options);
	const pending = new Map<
		string,
		Partial<ShellRun> & { state: RunFinished["state"] }
	>();
	const stopping = new Map<
		string,
		Promise<"stopped" | "unconfirmed" | "final">
	>();
	const store = () => {
		if (!options.store) throw new Error("shell_tracking_unavailable");
		return options.store;
	};
	async function finish(
		id: string,
		change: Partial<ShellRun> & { state: RunFinished["state"] },
	) {
		pending.set(id, change);
		const moved = await store().write((db) => ledger.finalize(db, id, change));
		pending.delete(id);
		if (!moved) return;
		changed();
		log.info("shell.run_finished", {
			attemptId: id,
			status: change.state,
			exitCode: change.exitCode ?? -1,
		});
	}
	async function execute(r: ShellRun) {
		const sessionId = crypto.randomUUID();
		const started = await store().write((db) =>
			repository.transition(db, r.id, ["queued"], {
				state: "running",
				sessionId,
				startedAt: now(),
				updatedAt: now(),
			}),
		);
		if (!started || closed) return;
		let s: Session;
		try {
			s = sessions.launchRun(
				sessionId,
				r.task,
				r.command,
				options.projects!(r.projectId)!.cwd,
			);
		} catch {
			await finish(r.id, { state: "cancelled", reason: "spawn_failed" });
			return;
		}
		s.attemptId = r.id;
		log.info("shell.run_started", { attemptId: r.id });
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const timedOut = await Promise.race([
				s.exit.then(() => false),
				new Promise<boolean>((resolve) => {
					timer = setTimeout(() => resolve(true), r.timeoutSeconds * 1000);
				}),
			]);
			if (closed) return;
			if (stopping.has(r.id)) {
				await stopping.get(r.id);
				return;
			}
			if (timedOut) {
				const confirmed = await sessions.terminate(s);
				if (closed) return;
				await finish(r.id, {
					state: confirmed ? "timed_out" : "unknown",
					...(confirmed ? {} : { reason: "stop_unconfirmed" as const }),
					exitCode: s.exitCode ?? null,
					...s.output.result(),
				});
			} else
				await finish(r.id, {
					state: "completed",
					exitCode: s.exitCode ?? null,
					...s.output.result(),
				});
		} finally {
			clearTimeout(timer);
		}
	}
	async function pump() {
		for (const [id, change] of pending) {
			await finish(id, change);
		}
		const rows = store().read((db) => repository.list(db, true));
		if (
			rows.some((r) => r.state === "running") ||
			[...sessions.entries.values()].some(
				(s) => s.kind === "run" && s.status === "running",
			)
		)
			return;
		const next = rows.find((r) => r.state === "queued");
		if (next) await execute(next);
	}
	const kick = () => {
		if (closed || !recovered || !shell || !options.store || busy) return;
		busy = pump()
			.catch(() => {
				log.warn("shell.run_save_failed", { reason: "save_failed" });
			})
			.finally(() => {
				busy = undefined;
			});
	};
	const unsubscribe = options.store?.onCommit(() => {
		ledger.flushCommitted();
		changed();
		kick();
	});
	const sweep = setInterval(kick, options.sweepMs ?? 5000);
	sweep.unref?.();
	return {
		available: () => !!shell && !!options.store,
		list() {
			const list = [...sessions.entries.values()].map(sessions.view);
			for (const s of list) {
				const attemptId = sessions.entries.get(s.id)?.attemptId;
				const saved =
					attemptId &&
					options.store?.read((db) => repository.get(db, attemptId));
				if (saved) s.state = saved.state;
			}
			return {
				available: !!shell,
				revision,
				limit: options.limit ?? 4,
				sessions: list,
			};
		},
		start: (
			request: Parameters<typeof sessions.start>[0] & { title?: string },
		) => sessions.start(request, request.title),
		restart: sessions.restart,
		input: sessions.input,
		resize: sessions.resize,
		stream: sessions.stream,
		enqueueRunInTransaction(db: Database, request: EnqueueRun) {
			if (!shell) throw new Error("shell_unavailable");
			return ledger.enqueue(db, request);
		},
		runInTransaction: repository.get,
		recentInTransaction: (db: Database) => repository.list(db, false, 5),
		cancelInTransaction: ledger.cancel,
		pruneInTransaction: repository.prune,
		onFinishedInTransaction: ledger.onFinishedInTransaction,
		onFinishedCommitted: ledger.onFinishedCommitted,
		async recover() {
			if (recovered) return;
			await ledger.recover();
			recovered = true;
			changed();
			kick();
		},
		async flush() {
			kick();
			await busy;
		},
		async stop(id: string): Promise<"stopped" | "unconfirmed" | "final"> {
			const previous = stopping.get(id);
			if (previous) return previous;
			const r = store().read((db) => repository.get(db, id));
			if (!r) throw new Error("shell_not_found");
			if (isFinal(r.state)) {
				const s = r.sessionId ? sessions.entries.get(r.sessionId) : undefined;
				return r.reason === "stop_unconfirmed" && s?.status === "running"
					? "unconfirmed"
					: "final";
			}
			if (r.state === "queued") {
				const cancelled = await store().write((db) => ledger.cancel(db, id));
				if (cancelled) return "stopped";
				return this.stop(id);
			}
			const s = r.sessionId ? sessions.entries.get(r.sessionId) : undefined;
			if (!s) return "unconfirmed";
			const task = (async () => {
				const confirmed = await sessions.terminate(s);
				await finish(id, {
					state: "unknown",
					reason: confirmed ? "stopped_by_person" : "stop_unconfirmed",
					exitCode: s.exitCode ?? null,
					...s.output.result(),
				});
				return confirmed ? ("stopped" as const) : ("unconfirmed" as const);
			})();
			stopping.set(id, task);
			try {
				return await task;
			} finally {
				stopping.delete(id);
			}
		},
		closeAll() {
			closed = true;
			clearInterval(sweep);
			unsubscribe?.();
			sessions.closeAll();
		},
	};
}
export type ShellService = ReturnType<typeof createShell>;
export type { ShellOptions } from "./types";
