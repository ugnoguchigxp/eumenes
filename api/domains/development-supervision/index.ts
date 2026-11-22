import type { Database } from "bun:sqlite";
import { getLogger } from "../../infrastructure/logger";
import type { SqliteStore } from "../../infrastructure/sqlite";
import { hash, type Capabilities } from "../capabilities";
import type { InferencePort } from "../inference";
import type { QueueService } from "../queue";
import {
	authorize,
	childObservation,
	designBinding,
	linkedGrant,
	liveGrant,
	parentSource,
	sourceCurrent,
} from "./authority";
import type {
	SupervisedAuthorityRequest,
	SupervisedSource,
	SupervisionBoardControl,
	SupervisionHost,
} from "./contracts";
import { amend, expectedControl, startStop, stopTask } from "./controls";
import { registerJobs } from "./jobs";
import { recordQuestion } from "./questions";
import { reconcileInTransaction, saveWork, scheduleWork } from "./reconcile";
import {
	boardRevision,
	grantsOf,
	parentOf,
	parentOfRun,
	parents,
} from "./repository";
import type { Parent } from "./state";
import { controlsFor, createTaskPort } from "./task";
import { progressOf, rows } from "./views";

export { migrations } from "./repository";
export * from "./contracts";

const log = getLogger("development-supervision");

type Deps = {
	store: SqliteStore;
	queue: QueueService;
	capabilities: Capabilities;
	inference: InferencePort;
	now?: () => number;
};

export function createDevelopmentSupervision({
	store,
	queue,
	capabilities,
	inference,
	now = Date.now,
}: Deps) {
	let host: SupervisionHost | undefined;
	let closed = false;
	let dirty = false;
	let maintaining: Promise<void> | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	const abortJobs = new Set<string>();

	const available = () =>
		!closed &&
		!!host &&
		!!inference.captureUserControlInTransaction &&
		!!inference.executeControl &&
		!!inference.acceptInTransaction;
	function requiredHost() {
		if (!host || !available()) throw new Error("supervision_unavailable");
		return host;
	}
	function cancelJob(db: Database, id: string | null) {
		if (id && queue.cancelInTransaction(db, id, "cancel_requested"))
			abortJobs.add(id);
	}
	const schedule = scheduleWork(queue);
	const save = (db: Database, parent: Parent, prior: Parent) =>
		saveWork(db, parent, prior, now(), host);
	async function recover() {
		if (!host || closed) return;
		if (!maintaining) {
			const currentHost = host;
			maintaining = store
				.write((db) => {
					for (const parent of parents(db, { pending: true })) {
						try {
							db.transaction(() =>
								reconcileInTransaction(db, currentHost, parent, {
									queue,
									now,
									cancelJob,
									schedule,
									save,
								}),
							)();
						} catch (error) {
							log.warn("supervision.reconcile_failed", {
								taskId: parent.id,
								reason: error instanceof Error ? error.name : "unknown",
							});
						}
					}
				})
				.then(() => {
					queue.wake();
				})
				.finally(() => {
					maintaining = undefined;
				});
		}
		await maintaining;
	}
	function flush() {
		if (closed) return;
		if (abortJobs.size) {
			queue.flushCancellations([...abortJobs]);
			abortJobs.clear();
		}
		queue.wake();
		void recover().catch(() =>
			log.warn("supervision.maintenance_failed", {
				reason: "store_unavailable",
			}),
		);
	}
	const releaseCommit = store.onCommit(() => {
		if (!dirty) return;
		dirty = false;
		queueMicrotask(flush);
	});
	registerJobs({
		queue,
		inference,
		getHost: () => host,
		now,
		save,
		kick: flush,
	});

	const changed = () => {
		dirty = true;
	};
	const { currentParent, controlled } = controlsFor({
		requiredHost,
		save,
		changed,
	});
	const task = createTaskPort(
		{
			getHost: () => host,
			requiredHost,
			capabilities,
			now,
			save,
			cancelJob,
			schedule,
			changed,
		},
		{ currentParent, controlled },
	);

	return {
		task,
		configure(currentHost: SupervisionHost) {
			host = currentHost;
			timer ??= setInterval(flush, 2_000);
			timer.unref();
		},
		availableInTransaction: available,
		sourceRunInTransaction: (db: Database, id: string) =>
			parentOf(db, id)?.source.runId ?? null,
		progressInTransaction(db: Database, parentId: string) {
			const parent = parentOf(db, parentId);
			return host &&
				parent &&
				!parent.forgotten &&
				sourceCurrent(host, db, parent)
				? progressOf(parent)
				: null;
		},
		boardRowsInTransaction(
			db: Database,
			filter: { conversationId?: string; workspaceRef?: string } = {},
		) {
			const currentHost = host;
			return currentHost
				? parents(db, filter)
						.filter((parent) => sourceCurrent(currentHost, db, parent))
						.flatMap(rows)
				: [];
		},
		boardRevisionInTransaction: boardRevision,
		designBindingInTransaction(
			db: Database,
			documentId: string,
			parentId: string,
		) {
			return host ? designBinding(host, db, documentId, parentId) : null;
		},
		researchGrantInTransaction(
			db: Database,
			source: Parameters<SupervisionHost["validSourceInTransaction"]>[1],
			workId: string,
		) {
			const parent = parentOfRun(db, source.runId);
			if (
				!host ||
				!parent ||
				parent.stop ||
				parent.forgotten ||
				hash(source) !== hash(parent.source) ||
				!sourceCurrent(host, db, parent)
			)
				return null;
			return (
				grantsOf(db, parent.id).find(
					(grant) =>
						grant.kind !== "claude" &&
						grant.workId === workId &&
						!grant.revoked &&
						grant.source.delegation.parentGeneration === parent.generation &&
						parent.research.some(
							({ grantRef }) => grantRef === grant.source.delegation.grantRef,
						),
				) ?? null
			);
		},
		parentSourceInTransaction(db: Database, source: SupervisedSource) {
			return host ? parentSource(host, db, source, now()) : null;
		},
		authorizeInTransaction(db: Database, input: SupervisedAuthorityRequest) {
			return host ? authorize(host, db, input, now()) : null;
		},
		observeInTransaction(
			db: Database,
			source: SupervisedSource,
			childWorkId: string,
		) {
			const grant = linkedGrant(db, source, childWorkId);
			if (!host || !grant) return false;
			const parent = parentOf(db, grant.source.delegation.parentWorkId);
			if (
				parent &&
				grant.kind === "claude" &&
				liveGrant(host, db, grant, parent, now())
			) {
				const observation = childObservation(host, db, grant);
				if (observation) recordQuestion(db, parent, grant, observation);
			}
			dirty = true;
			return true;
		},
		controlFromBoardInTransaction(
			db: Database,
			input: SupervisionBoardControl,
		) {
			const parent = currentParent(db, input.parentId, input.conversationId);
			const currentHost = requiredHost();
			if (input.action === "status") {
				expectedControl(parent, input);
				return progressOf(parent);
			}
			controlled(db, parent, input.operationId, input, () => {
				const task = expectedControl(parent, input);
				const cancel = (id: string | null) => cancelJob(db, id);
				if (input.action === "amend")
					amend(currentHost, db, parent, task, input.request, cancel);
				else if (task) stopTask(currentHost, db, parent, task, cancel);
				else startStop(currentHost, db, parent, cancel, "cancelled");
			});
			return progressOf(parent);
		},
		flush,
		recover,
		close() {
			closed = true;
			if (timer) clearInterval(timer);
			releaseCommit();
		},
	};
}

export type DevelopmentSupervisionService = ReturnType<
	typeof createDevelopmentSupervision
>;
