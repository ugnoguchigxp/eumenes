import type { Database } from "bun:sqlite";
import { getLogger } from "../../infrastructure/logger";
import type { SqliteStore } from "../../infrastructure/sqlite";
import type { Capabilities } from "../capabilities";
import type { InferencePort } from "../inference";
import type { QueueService } from "../queue";
import {
	isStandardExecutionSource,
	isSupervisedExecutionSource,
	type OwnedSupervisedExecutionSource,
} from "../tool-runtime";
import { type Host, type Runner, type Work } from "./contracts";
import { DECISION_JOB, registerDecisionJobs } from "./jobs";
import { drive, recover, tryRecovery } from "./driver";
import { createTaskPort } from "./task";
import {
	authorityCurrent,
	closeQuestion,
	escalatePendingQuestion,
	finish,
	newId,
	requestStop,
	view,
	supervisedView,
	workWorkspace,
} from "./lifecycle";
import { pending, read, save, terminal } from "./repository";

export { migrations } from "./repository";
export {
	adapterRef,
	type Runner,
	type Host,
	type ClaudeRunAuthorization,
	type SupervisedAuthority,
	type SupervisedView,
} from "./contracts";
const log = getLogger("claude-code");

type Deps = {
	store: SqliteStore;
	queue: QueueService;
	capabilities: Capabilities;
	inference: InferencePort;
	runner?: Runner;
	goalRunners?: ReadonlyMap<string, Runner>;
	now?: () => number;
};

const capableRunner = (client: Runner | undefined) =>
	!!client?.ready() &&
	!!client.supportsSupervised?.() &&
	!!client.present &&
	!!client.recover &&
	!!client.approveTool;

const canSchedule = (work: Work) =>
	!terminal(work) &&
	!work.decisionId &&
	!work.effect &&
	!work.question &&
	work.supervision?.blocked !== "verification_isolation_unavailable" &&
	work.supervision?.blocked !== "workspace_inputs_changed";
const isNewProgress = (
	work: Work,
	at: number,
): work is Work & { observation: NonNullable<Work["observation"]> } =>
	work.status === "waiting_child" &&
	Boolean(work.observation?.evidence?.length) &&
	work.observation!.seq > work.progressSeq &&
	at - work.progressAt >= 60_000 &&
	work.progressCalls < 6 &&
	work.maxCalls - work.calls > 4;

export function createClaudeCode({
	store,
	queue,
	capabilities,
	inference,
	runner,
	goalRunners,
	now = Date.now,
}: Deps) {
	let host: Host | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let maintenance: Promise<void> | undefined;
	let closed = false;
	let nextProbe = 0;
	let nextRecoveryCheck = 0;
	const abortJobs = new Set<string>();
	const configured = () =>
		!closed &&
		!!host &&
		!!inference.captureUserControlInTransaction &&
		!!inference.executeControl &&
		!!inference.acceptInTransaction;
	const available = () => configured() && !!runner?.ready();
	const runnerFor = ({
		source,
		supervision,
	}: Pick<Work, "source" | "supervision">) =>
		isSupervisedExecutionSource(source) && source.goal
			? goalRunners?.get(supervision?.authorization.workspaceRef ?? "")
			: runner;
	const runners = [
		...new Set(
			[runner, ...(goalRunners?.values() ?? [])].filter(
				(item): item is Runner => !!item,
			),
		),
	];
	const availabilityListeners = new Set<() => void>();
	const readiness = () =>
		runners.map((runner) => capableRunner(runner)).join(",");
	const supervisedAvailable = (forGoal = false, workspaceRef?: string) =>
		configured() &&
		!!host?.supervised &&
		(forGoal
			? workspaceRef === undefined
				? [...(goalRunners?.values() ?? [])].some(capableRunner)
				: capableRunner(goalRunners?.get(workspaceRef))
			: capableRunner(runner));
	function cancel(
		db: Database,
		work: Work,
		reason: "cancel" | "amend" | "expired" | "forgotten",
		operationId?: string,
	) {
		if (!host) return;
		if (work.decisionId) {
			queue.cancelInTransaction(db, work.decisionId, "cancel_requested");
			abortJobs.add(work.decisionId);
		}
		requestStop(db, host, work, reason, now(), operationId);
		save(db, work, now());
	}

	registerDecisionJobs(queue, inference, () => host, now, kick);
	const { task, supervised } = createTaskPort({
		capabilities,
		getHost: () => host,
		available,
		supervisedAvailable,
		now,
		cancel,
	});

	function schedule(db: Database, work: Work) {
		if (!host || !canSchedule(work)) return;
		if (work.pendingRunnerQuestion) {
			if (work.calls >= work.maxCalls) escalatePendingQuestion(work);
			else {
				work.status = "deciding";
				queueDecision(db, work, "question");
			}
			save(db, work, now());
			return;
		}
		if (work.executionId) {
			if (!isNewProgress(work, now())) return;
			work.progressSeq = work.observation.seq;
			work.progressAt = now();
			queueDecision(db, work, "progress");
		} else {
			if (!work.holdsWorkspace) {
				const workspace = workWorkspace(host, work);
				const reservation = workspace.hold(
					db,
					work.id,
					work.supervision?.authorization,
				);
				if (
					!reservation ||
					(work.supervision && typeof reservation !== "object")
				) {
					if (reservation) workspace.release(db, work.id, true);
					if (work.supervision) {
						const blocker = workspace.blocker?.(db, work.id);
						const summary =
							blocker?.state === "unknown"
								? "他タスクの停止未確認のため起動を保留しています。"
								: work.supervision.authorization.mode === "read"
									? "読取り枠が空くまで待機しています。"
									: "編集枠が空くまで待機しています。";
						if (work.summary !== summary) {
							work.summary = summary;
							work.observedAt = now();
							work.notice = newId();
							save(db, work, now());
						}
					}
					return;
				}
				if (work.supervision && typeof reservation === "object")
					work.supervision.lease = reservation;
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
			lane:
				work.supervision || mode === "progress" ? "background" : "interactive",
			deadlineAtMs: work.deadline,
			payload: { id: work.id },
			maxAttempts: 1,
		}).job.id;
	}

	async function maintain() {
		const currentHost = host;
		if (!currentHost || closed) return;
		if (runners.length && now() >= nextProbe) {
			nextProbe = now() + 5_000;
			const previous = readiness();
			await Promise.all(runners.map((client) => client.probe?.()));
			if (readiness() !== previous)
				for (const listener of availabilityListeners) listener();
		}
		if (abortJobs.size) {
			queue.flushCancellations([...abortJobs]);
			abortJobs.clear();
		}
		if (!store.readSnapshot((db) => pending(db).length)) return;
		const checkRecovery = now() >= nextRecoveryCheck;
		if (checkRecovery) nextRecoveryCheck = now() + 5_000;
		const rows = await store.write((db) => {
			const external: Work[] = [];
			const unconfirmed: {
				source: OwnedSupervisedExecutionSource;
				id: string;
			}[] = [];
			for (const work of pending(db)) {
				enforceDeadlines(db, currentHost, work, now(), cancel);
				deliverNotice(db, currentHost, work, now());
				schedule(db, work);
				if (
					(work.executionId || work.effect?.kind === "read_events") &&
					!terminal(work)
				)
					external.push(work);
				if (
					checkRecovery &&
					work.stop === "unconfirmed" &&
					isSupervisedExecutionSource(work.source)
				)
					unconfirmed.push({ id: work.id, source: work.source });
			}
			return { external, unconfirmed };
		});
		queue.wake();
		if (abortJobs.size) {
			queue.flushCancellations([...abortJobs]);
			abortJobs.clear();
		}
		await Promise.all(
			rows.external.map((work) => {
				const client = runnerFor(work);
				if (!client) return;
				return drive(
					{
						store,
						now,
						cancel,
						cancelDecision(db, jobId) {
							queue.cancelInTransaction(db, jobId, "cancel_requested");
							abortJobs.add(jobId);
						},
					},
					currentHost,
					client,
					work,
				);
			}),
		);
		await Promise.all(
			rows.unconfirmed.map(({ id, source }) =>
				tryRecovery((proof) => recoverSupervised(source, id, proof)),
			),
		);
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
	async function recoverSupervised(
		source: OwnedSupervisedExecutionSource,
		id: string,
		proof: "process_exit" | "host_reboot",
	) {
		const currentHost = host;
		const client = store.read((db) => {
			if (!supervised.viewInTransaction(db, source, id)) return undefined;
			const work = read(db, id);
			return work ? runnerFor(work) : undefined;
		});
		if (!currentHost || !client?.supportsSupervised?.()) return false;
		const recovered = await recover(
			store,
			currentHost,
			client,
			id,
			proof,
			(db) => !!supervised.viewInTransaction(db, source, id),
			now,
		);
		if (recovered) {
			nextProbe = 0;
			void kick();
		}
		return recovered;
	}
	return {
		task,
		supervised,
		onAvailabilityChange(listener: () => void) {
			availabilityListeners.add(listener);
			return () => {
				availabilityListeners.delete(listener);
			};
		},
		availableInTransaction: available,
		supervisedAvailableInTransaction: supervisedAvailable,
		configure(value: Host) {
			host = value;
		},
		sourceRunInTransaction(db: Database, id: string) {
			const work = read(db, id);
			return work && isStandardExecutionSource(work.source)
				? work.source.runId
				: null;
		},
		recoverSupervised,
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

function enforceDeadlines(
	db: Database,
	currentHost: Host,
	work: Work,
	at: number,
	cancel: (db: Database, work: Work, reason: "expired" | "forgotten") => void,
) {
	if (terminal(work) || work.effect?.kind === "stop") return;
	if (
		work.deadline <= at ||
		!authorityCurrent(currentHost, db, work) ||
		(!!work.supervision && (work.question?.expiresAt ?? Infinity) <= at)
	) {
		cancel(
			db,
			work,
			work.deadline <= at || (work.question?.expiresAt ?? Infinity) <= at
				? "expired"
				: "forgotten",
		);
		return;
	}
	if (!work.supervision && work.question && work.question.expiresAt <= at) {
		const fromRunner = work.questionFromRunner;
		closeQuestion(db, currentHost, work);
		work.status = fromRunner && work.executionId ? "waiting_child" : "deciding";
		work.summary = "質問の回答期限が過ぎたため、状況を再確認しています。";
		work.observedAt = at;
		save(db, work, at);
	}
}

function deliverNotice(
	db: Database,
	currentHost: Host,
	work: Work,
	at: number,
) {
	if (!work.notice) return;
	const notice =
		work.supervision && isSupervisedExecutionSource(work.source)
			? currentHost.supervised?.observeInTransaction(
					db,
					work.source,
					supervisedView(work),
					work.notice,
				)
			: isStandardExecutionSource(work.source) &&
				currentHost.deliverInTransaction(db, view(work), work.notice);
	if (notice) {
		work.deliveredNotice = work.notice;
		work.notice = null;
		save(db, work, at);
	}
}
