import type { Database } from "bun:sqlite";
import { getLogger } from "../../infrastructure/logger";
import type { SqliteStore } from "../../infrastructure/sqlite";
import type { Capabilities } from "../capabilities";
import type { InferencePort } from "../inference";
import type { QueueService } from "../queue";
import {
	isStandardExecutionSource,
	isGoalExecutionSource,
	isSupervisedExecutionSource,
	type OwnedSupervisedExecutionSource,
} from "../tool-runtime";
import { type Host, type Runner, type Work } from "./contracts";
import { DECISION_JOB, registerDecisionJobs } from "./jobs";
import { drive, recover, tryRecovery } from "./driver";
import { createTaskPort } from "./task";
import { goalTaskView } from "./goal-task";
import {
	authorityCurrent,
	closeQuestion,
	escalatePendingQuestion,
	finish,
	newId,
	releaseGoalQuestionSlot,
	requestStop,
	view,
	supervisedView,
	workWorkspace,
} from "./lifecycle";
import { pending, read, save, terminal } from "./repository";
import { createWatch } from "./watch";
import {
	enqueueWorksDependency,
	registerWorksDependencyJobs,
} from "./works-dependency";

export { migrations } from "./repository";
export type { GoalTaskView } from "./goal-task";
export {
	adapterRef,
	worksAdapterRef,
	WorksSelectionRequired,
	type WorksTarget,
	type WorksDependencyApproval,
	type WorksDependencyRequest,
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
	/** The working folder: the watch pane shows paths inside it relative to it. */
	root?: string;
	protectedPaths?: readonly string[];
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
	!work.dependency?.jobId &&
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

function schedule(
	db: Database,
	host: Host,
	work: Work,
	now: () => number,
	queueDecision: (db: Database, work: Work, mode: Work["decisionMode"]) => void,
) {
	if (!canSchedule(work)) return;
	if (work.pendingRunnerQuestion) {
		if (work.calls >= work.maxCalls) {
			escalatePendingQuestion(work);
			releaseGoalQuestionSlot(db, host, work);
		} else {
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
				if (work.supervision || isGoalExecutionSource(work.source)) {
					const blocker = workspace.blocker?.(db, work.id);
					const summary =
						blocker?.state === "unknown"
							? "他タスクの停止未確認のため起動を保留しています。"
							: work.supervision?.authorization.mode === "read" ||
								  work.mode === "analysis"
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
export function createClaudeCode({
	store,
	queue,
	capabilities,
	inference,
	runner,
	goalRunners,
	root,
	protectedPaths,
	now = Date.now,
}: Deps) {
	let host: Host | undefined;
	let goalHost: Host["goal"];
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
		works,
	}: Pick<Work, "source" | "supervision" | "works">) =>
		works
			? host?.works?.runner(works)
			: isSupervisedExecutionSource(source) && source.goal
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
		[runner?.ready() ?? false, ...runners.map(capableRunner)].join(",");
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
		if (work.dependency?.jobId) {
			queue.cancelInTransaction(db, work.dependency.jobId, "cancel_requested");
			abortJobs.add(work.dependency.jobId);
		}
		requestStop(db, host, work, reason, now(), operationId);
		save(db, work, now());
	}

	registerDecisionJobs(queue, inference, () => host, now, kick);
	registerWorksDependencyJobs(queue, store, () => host, now, kick);
	const { task, worksTask, goal, supervised } = createTaskPort({
		capabilities,
		getHost: () => host,
		available,
		supervisedAvailable,
		now,
		cancel,
		queueDependency: (db, work) => enqueueWorksDependency(queue, db, work),
	});

	function queueDecision(db: Database, work: Work, mode: Work["decisionMode"]) {
		work.decisionMode = mode;
		work.decisionId = queue.enqueueInTransaction(db, {
			scope: "claude-code",
			kind: DECISION_JOB,
			dedupeKey: newId(),
			subjectRef: work.id,
			concurrencyKey: `claude-code:${work.id}`,
			lane:
				work.supervision ||
				isGoalExecutionSource(work.source) ||
				mode === "progress"
					? "background"
					: "interactive",
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
			const unconfirmed: Work[] = [];
			const idle: Work[] = [];
			for (const work of pending(db)) {
				enforceDeadlines(db, currentHost, work, now(), cancel);
				deliverNotice(db, currentHost, work, now());
				schedule(db, currentHost, work, now, queueDecision);
				if (work.idlePending) idle.push(work);
				if (
					(work.executionId || work.effect?.kind === "read_events") &&
					!terminal(work)
				)
					external.push(work);
				if (
					checkRecovery &&
					work.stop === "unconfirmed" &&
					(work.works || isSupervisedExecutionSource(work.source))
				)
					unconfirmed.push(work);
			}
			return { external, unconfirmed, idle };
		});
		queue.wake();
		if (abortJobs.size) {
			queue.flushCancellations([...abortJobs]);
			abortJobs.clear();
		}
		await Promise.allSettled(
			rows.external.map(async (work) => {
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
			rows.unconfirmed.map(({ id, source, works }) =>
				tryRecovery((proof) =>
					works
						? recoverAuthorized(id, proof, (db) => {
								const target = read(db, id)?.works;
								return (
									target?.id === works.id &&
									target.generation === works.generation
								);
							})
						: isSupervisedExecutionSource(source)
							? recoverSupervised(source, id, proof)
							: Promise.resolve(false),
				),
			),
		);
		await retireWorksRunners(rows.idle, runnerFor, store, now);
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
	function recoverSupervised(
		source: OwnedSupervisedExecutionSource,
		id: string,
		proof: "process_exit" | "host_reboot",
	) {
		return recoverAuthorized(
			id,
			proof,
			(db) => !!supervised.viewInTransaction(db, source, id),
		);
	}

	async function recoverAuthorized(
		id: string,
		proof: "process_exit" | "host_reboot",
		current: (db: Database) => boolean,
	) {
		const currentHost = host;
		const owner = store.read((db) => {
			if (!current(db)) return undefined;
			const work = read(db, id);
			return work
				? { client: runnerFor(work), works: !!work.works }
				: undefined;
		});
		const client = owner?.client;
		if (
			!currentHost ||
			!client?.recover ||
			(!owner?.works && !client.supportsSupervised?.())
		)
			return false;
		const recovered = await recover(
			store,
			currentHost,
			client,
			id,
			proof,
			current,
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
		worksTask,
		worksAvailableInTransaction: () => configured() && !!host?.works,
		goal,
		workingDirectory: root,
		protectedPaths,
		supervised,
		watch: createWatch({ store, runnerFor, root, now }),
		onAvailabilityChange(listener: () => void) {
			availabilityListeners.add(listener);
			return () => {
				availabilityListeners.delete(listener);
			};
		},
		availableInTransaction: available,
		supervisedAvailableInTransaction: supervisedAvailable,
		configure(value: Host) {
			host = goalHost ? { ...value, goal: goalHost } : value;
		},
		configureGoal(value: NonNullable<Host["goal"]>) {
			goalHost = value;
			if (host) host = { ...host, goal: value };
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

async function retireWorksRunners(
	idle: readonly Work[],
	runnerFor: (work: Work) => Runner | undefined,
	store: SqliteStore,
	now: () => number,
) {
	await Promise.allSettled(
		idle.map(async (work) => {
			const client = runnerFor(work);
			if (client?.retireIdle && !(await client.retireIdle())) return;
			if (!client && work.works) return;
			await store.write((db) => {
				const saved = read(db, work.id);
				if (!saved?.idlePending || saved.generation !== work.generation) return;
				saved.idlePending = false;
				save(db, saved, now());
			});
		}),
	);
}

function enforceDeadlines(
	db: Database,
	currentHost: Host,
	work: Work,
	at: number,
	cancel: (db: Database, work: Work, reason: "expired" | "forgotten") => void,
) {
	if (terminal(work) || work.effect?.kind === "stop") return;
	const authorityRevoked = work.dependency?.jobId
		? !currentHost.works?.dependencies ||
			!isStandardExecutionSource(work.source) ||
			!currentHost.validSourceInTransaction(db, work.source)
		: !authorityCurrent(currentHost, db, work);
	if (
		work.deadline <= at ||
		authorityRevoked ||
		((!!work.supervision || isGoalExecutionSource(work.source)) &&
			(work.question?.expiresAt ?? Infinity) <= at)
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
	if (isGoalExecutionSource(work.source)) {
		if (!work.forgotten)
			currentHost.goal?.observeInTransaction?.(
				db,
				work.source,
				goalTaskView(work),
			);
		work.notice = null;
		save(db, work, at);
		return;
	}
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
