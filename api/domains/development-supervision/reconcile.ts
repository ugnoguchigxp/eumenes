import type { Database } from "bun:sqlite";
import { hash } from "../capabilities";
import type { QueueService } from "../queue";
import { sourceCurrent } from "./authority";
import type { SupervisionHost } from "./contracts";
import { startStop } from "./controls";
import { enqueue } from "./jobs";
import { inspectDesign, observeResearch, planningHeld } from "./planning";
import { syncQuestions } from "./questions";
import { eraseChildRecords, saveParent, touchBoard } from "./repository";
import type { Parent } from "./state";
import { executionView, finishTask, result, rows } from "./views";
import { hasOldWork, inspectTask, workHold } from "./work";

export type Schedule = (
	db: Database,
	parent: Parent,
	kind: Parameters<typeof enqueue>[3],
	task?: Parameters<typeof enqueue>[4],
) => void;

export function scheduleWork(queue: QueueService): Schedule {
	return function schedule(
		db: Database,
		parent: Parent,
		kind: Parameters<typeof enqueue>[3],
		task?: Parameters<typeof enqueue>[4],
	) {
		try {
			enqueue(queue, db, parent, kind, task);
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "queue_full")
				throw error;
			if (task) workHold(task, "実行キューの空き待ち");
			else parent.reason = "監督キューの空き待ち";
		}
	};
}

function needsNotice(parent: Parent) {
	return parent.notices.some(({ active, delivered }) => active && !delivered);
}
export function markNotice(
	parent: Parent,
	id: string = crypto.randomUUID(),
	kind: Parent["notices"][number]["kind"] = "progress",
) {
	if (!parent.notices.some((notice) => notice.id === id))
		parent.notices.push({ id, active: true, delivered: false, kind });
}
export function saveWork(
	db: Database,
	parent: Parent,
	prior: Parent,
	now: number,
	host: SupervisionHost | undefined,
) {
	const before = rows(prior);
	const after = rows(parent);
	let changed =
		hash(before) !== hash(after) || parent.forgotten !== prior.forgotten;
	for (const task of parent.tasks) {
		const old = before.find(({ taskId }) => taskId === task.id);
		const next = after.find(({ taskId }) => taskId === task.id)!;
		const oldTask = prior.tasks.find(({ id }) => id === task.id);
		if (
			old &&
			(oldTask?.generation !== task.generation || hash(old) !== hash(next))
		) {
			task.revision++;
			changed = true;
		}
	}
	const visible =
		changed ||
		prior.generation !== parent.generation ||
		prior.phase !== parent.phase ||
		prior.reason !== parent.reason ||
		hash(prior.question) !== hash(parent.question) ||
		hash(prior.result) !== hash(parent.result) ||
		prior.designs.length !== parent.designs.length ||
		hash(parent.designUris) !== hash(prior.designUris) ||
		prior.stop !== parent.stop;
	if (visible) {
		parent.revision++;
		parent.observedAt = now;
		if (changed || parent.tasks.length > 0) touchBoard(db);
	}
	if (!parent.forgotten) {
		if (parent.questionOp && parent.questionOp !== prior.questionOp)
			markNotice(parent, parent.questionOp, "question");
		if (parent.result && !prior.result) {
			for (const notice of parent.notices)
				if (notice.kind === "progress" && !notice.delivered)
					notice.active = false;
			markNotice(parent, undefined, "final");
		}
		if (!parent.result && hash(parent.designUris) !== hash(prior.designUris))
			markNotice(parent);
		if (
			!parent.result &&
			parent.tasks.some((task) => {
				const old = prior.tasks.find(({ id }) => id === task.id);
				return (
					(task.phase === "replan" &&
						task.result &&
						hash(task.result) !== hash(old?.result ?? null)) ||
					(task.state === "held" &&
						task.blockerRef &&
						task.blockerRef !== old?.blockerRef)
				);
			})
		)
			markNotice(parent);
	}
	saveParent(db, parent, parent.phase !== "finished" || needsNotice(parent));
	if (visible && !parent.forgotten)
		host?.ledgerInTransaction?.(db, executionView(parent));
}
function isOpen(queue: QueueService, db: Database, id: string | null) {
	const state = id && queue.getInTransaction(db, id)?.state;
	return state === "queued" || state === "running" || state === "retry_wait";
}
function settleParent(parent: Parent) {
	if (
		parent.phase !== "active" ||
		!parent.tasks.length ||
		parent.tasks.some(({ phase }) => phase !== "finished")
	)
		return;
	const tasks = parent.tasks;
	const complete = tasks.filter(
		({ outcome }) => outcome === "succeeded",
	).length;
	const status =
		complete === tasks.length
			? "completed"
			: complete || tasks.some(({ outcome }) => outcome === "partial")
				? "partial"
				: tasks.every(({ outcome }) => outcome === "cancelled")
					? "cancelled"
					: tasks.every(({ outcome }) => outcome === "interrupted")
						? "interrupted"
						: "failed";
	parent.result = result(
		status,
		tasks
			.map(({ proposal, reason }) => `${proposal.title} · ${reason}`)
			.join("\n"),
		tasks.flatMap(({ result }) => result?.refs ?? []),
		tasks
			.filter(({ outcome }) => outcome !== "succeeded")
			.map(({ reason }) => reason),
	);
	const links = parent.designs
		.filter(({ generation }) => generation === parent.generation)
		.flatMap(({ documentId }) =>
			parent.designUris[documentId] ? [parent.designUris[documentId]!] : [],
		);
	if (links.length) parent.result.links = links.slice(-12);
	parent.phase = "finished";
}
export function reconcileInTransaction(
	db: Database,
	currentHost: SupervisionHost,
	parent: Parent,
	{
		queue,
		now,
		cancelJob,
		schedule,
		save,
	}: {
		queue: QueueService;
		now(): number;
		cancelJob(db: Database, id: string | null): void;
		schedule: Schedule;
		save(db: Database, parent: Parent, prior: Parent): void;
	},
) {
	const prior = structuredClone(parent);
	if (parent.phase !== "finished" || (parent.stop && parent.forgotten)) {
		if (
			!parent.stop &&
			(parent.deadline <= now() || !sourceCurrent(currentHost, db, parent))
		)
			startStop(
				currentHost,
				db,
				parent,
				(id) => cancelJob(db, id),
				"interrupted",
				parent.deadline > now(),
			);
		if (parent.stop) {
			if (!hasOldWork(currentHost, db, parent)) {
				for (const task of parent.tasks)
					if (task.phase !== "finished")
						finishTask(
							task,
							parent.stop,
							parent.stop === "cancelled"
								? "取り消しました。"
								: "期限または参照の失効により中断しました。",
						);
				parent.result = result(
					parent.stop,
					parent.stop === "cancelled"
						? "開発作業を取り消しました。"
						: "開発作業を中断しました。",
				);
				parent.phase = "finished";
				if (parent.forgotten) {
					eraseChildRecords(db, parent.id);
					erase(parent);
				}
			}
		} else {
			hasOldWork(currentHost, db, parent);
			if (parent.jobId && !isOpen(queue, db, parent.jobId)) {
				parent.jobId = null;
				planningHeld(
					parent,
					"監督の処理を再開できません。条件を確認してください。",
				);
			}
			if (parent.phase === "research") observeResearch(currentHost, db, parent);
			if (parent.phase === "waiting_design")
				inspectDesign(currentHost, db, parent);
			if (
				!parent.jobId &&
				(parent.phase === "authority" ||
					parent.phase === "plan" ||
					parent.phase === "design")
			)
				schedule(db, parent, parent.phase);
			for (const task of parent.tasks) {
				if (
					task.result?.status === "cancelled" &&
					task.phase !== "finished" &&
					!hasOldWork(currentHost, db, parent, task)
				) {
					finishTask(task, "cancelled", "タスクを取り消しました。");
					continue;
				}
				if (task.jobId && !isOpen(queue, db, task.jobId)) {
					finishTask(
						task,
						"partial",
						"監督の確認を再開できません。新しい対象版または条件が必要です。",
					);
					continue;
				}
				inspectTask(currentHost, db, parent, task, (kind, item) =>
					schedule(db, parent, kind, item),
				);
			}
			if (parent.phase === "active" && !parent.pendingTaskId) {
				const replan = parent.tasks.find(
					({ phase, result }) =>
						phase === "replan" && result?.status !== "cancelled",
				);
				if (replan) {
					parent.pendingTaskId = replan.id;
					parent.phase = "plan";
				}
			}
			syncQuestions(currentHost, db, parent, now(), markNotice);
			settleParent(parent);
		}
	}
	if (hash(parent) !== hash(prior)) save(db, parent, prior);
	if (!parent.forgotten) {
		let updated = false;
		for (const notice of parent.notices) {
			if (
				!notice.active ||
				notice.delivered ||
				(parent.questionOp && parent.questionOp !== notice.id)
			)
				continue;
			try {
				// Dialogue appends a message before it reserves queue capacity.
				// Roll back that delivery alone when its queue is full.
				const delivered = db.transaction(() =>
					currentHost.deliverInTransaction(
						db,
						executionView(parent),
						notice.id,
					),
				)();
				if (!delivered) continue;
				notice.delivered = true;
				updated = true;
			} catch (error) {
				if (!(error instanceof Error) || error.message !== "queue_full")
					throw error;
				break;
			}
		}
		if (updated)
			saveParent(
				db,
				parent,
				parent.phase !== "finished" || needsNotice(parent),
			);
	}
}
function erase(parent: Parent) {
	parent.source = { ...parent.source, request: "", digest: "" };
	delete parent.confirmation;
	parent.request = "";
	parent.reason = "";
	parent.references = [];
	parent.context = [];
	parent.controls = [];
	parent.tasks = [];
	parent.designs = [];
	parent.designUris = {};
	parent.research = [];
	parent.notices = [];
	parent.plan = null;
}
