import type { Database } from "bun:sqlite";
import { getLogger } from "../../infrastructure/logger";
import type { SqliteStore } from "../../infrastructure/sqlite";
import type { Capabilities } from "../capabilities";
import type { InferencePort } from "../inference";
import type { QueueService } from "../queue";
import { type Host, type Runner, type Work } from "./contracts";
import { DECISION_JOB, registerDecisionJobs } from "./jobs";
import { createTaskPort } from "./task";
import {
	acceptObservation,
	authorityCurrent,
	finish,
	newId,
	requestStop,
	view,
} from "./lifecycle";
import { pending, read, save, terminal } from "./repository";

export { migrations } from "./repository";
export { adapterRef, type Runner, type Host } from "./contracts";
const log = getLogger("claude-code");

type Deps = {
	store: SqliteStore;
	queue: QueueService;
	capabilities: Capabilities;
	inference: InferencePort;
	runner?: Runner;
	now?: () => number;
};

export function createClaudeCode({
	store,
	queue,
	capabilities,
	inference,
	runner,
	now = Date.now,
}: Deps) {
	let host: Host | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let maintenance: Promise<void> | undefined;
	let closed = false;
	let nextProbe = 0;
	const abortJobs = new Set<string>();
	const available = () =>
		!closed &&
		!!host &&
		!!runner?.ready() &&
		!!inference.captureUserControlInTransaction &&
		!!inference.executeControl &&
		!!inference.acceptInTransaction;
	function cancel(
		db: Database,
		work: Work,
		reason: "cancel" | "amend" | "expired" | "forgotten",
	) {
		if (!host) return;
		if (work.decisionId) {
			queue.cancelInTransaction(db, work.decisionId, "cancel_requested");
			abortJobs.add(work.decisionId);
		}
		requestStop(db, host, work, reason, now());
		save(db, work, now());
	}

	registerDecisionJobs(queue, inference, () => host, now, kick);
	const task = createTaskPort({
		capabilities,
		getHost: () => host,
		available,
		now,
		cancel,
	});

	function schedule(db: Database, work: Work) {
		if (
			!host ||
			terminal(work) ||
			work.decisionId ||
			work.effect ||
			work.question
		)
			return;
		if (work.executionId) {
			if (
				work.status !== "waiting_child" ||
				!work.observation?.evidence?.length ||
				work.observation.seq <= work.progressSeq ||
				now() - work.progressAt < 60_000 ||
				work.progressCalls >= 6 ||
				work.maxCalls - work.calls <= 4
			)
				return;
			work.progressSeq = work.observation.seq;
			work.progressAt = now();
			queueDecision(db, work, "progress");
		} else {
			if (!work.holdsWorkspace) {
				if (!host.workspace.hold(db, work.id)) return;
				work.holdsWorkspace = true;
			}
			if (work.calls >= work.maxCalls)
				finish(db, host, work, "partial", "判断回数の上限に達しました。");
			else {
				work.status = "deciding";
				queueDecision(db, work, "work");
			}
		}
		save(db, work, now());
	}
	function queueDecision(db: Database, work: Work, mode: Work["decisionMode"]) {
		work.decisionMode = mode;
		work.decisionId = queue.enqueueInTransaction(db, {
			scope: "claude-code",
			kind: DECISION_JOB,
			dedupeKey: newId(),
			subjectRef: work.id,
			concurrencyKey: `claude-code:${work.id}`,
			lane: mode === "progress" ? "background" : "interactive",
			deadlineAtMs: work.deadline,
			payload: { id: work.id },
			maxAttempts: 1,
		}).job.id;
	}

	async function maintain() {
		const currentHost = host;
		if (!currentHost || closed) return;
		if (runner?.probe && now() >= nextProbe) {
			nextProbe = now() + 5_000;
			await runner.probe();
		}
		if (abortJobs.size) {
			queue.flushCancellations([...abortJobs]);
			abortJobs.clear();
		}
		if (!store.readSnapshot((db) => pending(db).length)) return;
		const rows = await store.write((db) => {
			const external: Work[] = [];
			for (const work of pending(db)) {
				if (
					!terminal(work) &&
					work.effect?.kind !== "stop" &&
					(work.deadline <= now() ||
						(work.question?.expiresAt ?? Infinity) <= now() ||
						!authorityCurrent(currentHost, db, work))
				)
					cancel(
						db,
						work,
						work.deadline <= now() ||
							(work.question?.expiresAt ?? Infinity) <= now()
							? "expired"
							: "forgotten",
					);
				if (work.notice) {
					if (currentHost.deliverInTransaction(db, view(work), work.notice)) {
						work.deliveredNotice = work.notice;
						work.notice = null;
						save(db, work, now());
					}
				}
				schedule(db, work);
				if (work.executionId) external.push(work);
			}
			return external;
		});
		queue.wake();
		if (abortJobs.size) {
			queue.flushCancellations([...abortJobs]);
			abortJobs.clear();
		}
		if (!runner) return;
		await Promise.all(rows.map((work) => drive(currentHost, runner, work)));
	}

	async function drive(currentHost: Host, target: Runner, snapshot: Work) {
		const executionId = snapshot.executionId!;
		const effect = snapshot.effect;
		let observation;
		try {
			observation =
				effect?.kind === "start"
					? await target.start(effect.operation)
					: effect?.kind === "reply"
						? await target.reply(
								executionId,
								effect.id,
								effect.questionId,
								effect.answer,
							)
						: effect?.kind === "stop"
							? await target.stop(executionId, effect.id)
							: await target.inspect(executionId);
		} catch {
			// Preserve the intent on transport failure. An elapsed deadline never authorizes a fresh execution.
			if (effect?.kind !== "stop" || (snapshot.stopAt ?? Infinity) > now())
				return;
			observation = null;
		}
		if (
			effect?.kind === "stop" &&
			(snapshot.stopAt ?? Infinity) <= now() &&
			!observation?.managedExecutionStopped
		)
			observation = null;
		await store.write((db) => {
			const work = read(db, snapshot.id);
			if (
				!work ||
				work.generation !== snapshot.generation ||
				work.executionId !== executionId ||
				work.effect?.kind !== effect?.kind ||
				!acceptObservation(db, currentHost, work, observation)
			)
				return;
			if (
				work.status !== "waiting_child" &&
				snapshot.decisionMode === "progress" &&
				snapshot.decisionId
			) {
				queue.cancelInTransaction(db, snapshot.decisionId, "cancel_requested");
				abortJobs.add(snapshot.decisionId);
				if (work.decisionId === snapshot.decisionId) work.decisionId = null;
			}
			save(db, work, now());
		});
	}

	function kick() {
		if (closed || maintenance) return maintenance;
		maintenance = maintain()
			.catch(() => {
				log.warn("claude_code.maintenance_failed", {
					reason: "maintenance_failed",
				});
			})
			.finally(() => {
				maintenance = undefined;
			});
		return maintenance;
	}
	return {
		task,
		availableInTransaction: available,
		configure(value: Host) {
			host = value;
		},
		sourceRunInTransaction(db: Database, id: string) {
			return read(db, id)?.source.runId ?? null;
		},
		recover: kick,
		start() {
			timer ??= setInterval(kick, 500);
			timer.unref?.();
			void kick();
		},
		flush() {
			void kick();
		},
		async close() {
			closed = true;
			clearInterval(timer);
			await maintenance;
		},
	};
}

export type ClaudeCodeService = ReturnType<typeof createClaudeCode>;
