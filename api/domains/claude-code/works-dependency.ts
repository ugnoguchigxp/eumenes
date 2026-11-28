import type { Database } from "bun:sqlite";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { SqliteStore } from "../../infrastructure/sqlite";
import type { QueueService } from "../queue";
import { claudeInputDigest, codingCanonicalJSON } from "../coding";
import { isStandardExecutionSource } from "../tool-runtime";
import type { Host, Work, WorksDependencyRequest } from "./contracts";
import {
	authorityCurrent,
	closeQuestion,
	finish,
	newId,
	workWorkspace,
} from "./lifecycle";
import { read, save, terminal } from "./repository";
import { worksAuthorization } from "./works-authorization";

const jobKind = "claude-code.works-dependency";
type WorkInApproval = Work & {
	works: NonNullable<Work["works"]>;
	dependency: NonNullable<Work["dependency"]>;
};

function digest(work: Work, exclude?: string) {
	const scope = work.supervision?.authorization;
	return (
		scope &&
		claudeInputDigest(
			[...scope.readablePaths, ...scope.writablePaths],
			exclude,
			true,
		)
	);
}

function versionFile(work: NonNullable<Work["works"]>) {
	return join(work.root, "prototype.json");
}

function exactManifest(path: string) {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.size > 32 * 1024)
		throw new Error("prototype_dependency_inputs_changed");
	return readFileSync(path, "utf8");
}

function evidenceOf(
	work: Work,
	proposal: WorksDependencyRequest,
	inputDigest: string,
) {
	const scope = work.supervision?.authorization;
	return work.observation?.structuredEvidence?.some((entry) => {
		if (
			entry.ref !== proposal.evidenceRef ||
			entry.kind !== "check" ||
			entry.passed ||
			entry.inputDigest !== inputDigest ||
			!scope?.checks.some(
				(check) =>
					codingCanonicalJSON(check) === codingCanonicalJSON(entry.check),
			)
		)
			return false;
		return (entry.stderr ?? "").split("\n").some((line) => {
			const requested =
				/(?:prototype_import_unregistered |Cannot find module ['"])([^\s'"]+)/.exec(
					line,
				)?.[1];
			return (
				requested === proposal.name ||
				requested?.startsWith(proposal.name + "/")
			);
		});
	});
}

export function requestWorksDependency(
	db: Database,
	host: Host,
	work: Work,
	request: WorksDependencyRequest,
) {
	const inputDigest = digest(work);
	const path = work.works && versionFile(work.works);
	const sourceDigest = path && digest(work, path);
	if (
		!path ||
		!host.works?.dependencies ||
		work.executionId ||
		!work.observation?.managedExecutionStopped ||
		!inputDigest ||
		!sourceDigest ||
		!evidenceOf(work, request, inputDigest)
	) {
		finish(
			db,
			host,
			work,
			"partial",
			"依存の追加に必要な検査証跡または共有環境の設定が不足しています。",
		);
		return;
	}
	let manifest: string;
	try {
		manifest = exactManifest(path);
		if (digest(work) !== inputDigest)
			throw new Error("prototype_dependency_inputs_changed");
	} catch {
		finish(db, host, work, "partial", "依存の追加前に作品が更新されました。");
		return;
	}
	const id = newId();
	work.dependency = {
		id,
		generation: work.generation,
		request,
		inputDigest,
		sourceDigest,
		manifest,
	};
	work.question = {
		id,
		prompt: `Works「${work.works!.name}」に ${request.name}@${request.version} を追加する申請です。用途: ${request.usage}\n承認する場合は「承認 ${id}」、見送る場合は「否認 ${id}」と返信してください。`,
		inputSchema: { type: "string", enum: [`承認 ${id}`, `否認 ${id}`] },
		expiresAt: work.deadline,
	};
	work.status = "waiting_user";
	work.summary = "共有環境への依存追加の承認を待っています。";
	work.notice = newId();
}

export function answerWorksDependency(
	db: Database,
	host: Host,
	work: Work,
	original: string,
	at: number,
	enqueue: (db: Database, work: Work) => string,
) {
	const approval = work.dependency;
	if (
		!approval ||
		approval.generation !== work.generation ||
		!work.works ||
		!work.question
	)
		throw new Error("invalid_answer");
	const answer = original.trim();
	if (answer !== `承認 ${approval.id}` && answer !== `否認 ${approval.id}`)
		throw new Error("invalid_answer");
	if (answer.startsWith("否認")) {
		finish(db, host, work, "partial", "共有依存の追加は承認されませんでした。");
		return;
	}
	if (
		!authorityCurrent(host, db, work) ||
		digest(work) !== approval.inputDigest
	) {
		finish(
			db,
			host,
			work,
			"partial",
			"承認時に作品が更新されていたため、依存の追加を取り消しました。",
		);
		return;
	}
	closeQuestion(db, host, work);
	approval.jobId = enqueue(db, work);
	work.status = "queued";
	work.summary = "承認された依存を共有環境に準備しています。";
	work.observedAt = at;
	work.notice = newId();
}

export function enqueueWorksDependency(
	queue: QueueService,
	db: Database,
	work: Work,
) {
	return queue.enqueueInTransaction(db, {
		scope: "claude-code",
		kind: jobKind,
		subjectRef: work.id,
		dedupeKey: work.dependency!.id,
		concurrencyKey: "works-dependency-publication",
		lane: "background",
		deadlineAtMs: work.deadline,
		payload: { id: work.id },
		maxAttempts: 3,
	}).job.id;
}

export function registerWorksDependencyJobs(
	queue: QueueService,
	store: SqliteStore,
	getHost: () => Host | undefined,
	now: () => number,
	kick: () => void,
) {
	function current(
		db: Database,
		id: string,
		jobId: string,
	): WorkInApproval | null {
		const work = read(db, id);
		const host = getHost();
		const lease = work?.supervision?.lease;
		return host?.works?.dependencies &&
			work?.works &&
			work.dependency &&
			work.dependency.jobId === jobId &&
			work.dependency.generation === work.generation &&
			!terminal(work) &&
			!work.forgotten &&
			now() < work.deadline &&
			isStandardExecutionSource(work.source) &&
			host.validSourceInTransaction(db, work.source) &&
			lease &&
			workWorkspace(host, work).current?.(db, lease)
			? (work as WorkInApproval)
			: null;
	}
	queue.registerHandler({
		kind: jobKind,
		payloadVersions: [1],
		schema: z.strictObject({ id: z.uuid() }),
		recovery: "replay_safe",
		prepareInTransaction(db, claim) {
			const work = current(db, claim.payload.id, claim.jobId);
			return work
				? { status: "ready", input: { work, jobId: claim.jobId } }
				: { status: "stale", reason: "prototype_dependency_stale" };
		},
		async execute({ work, jobId }, { signal }) {
			const host = getHost()!;
			const assertCurrent = (alreadyPublished?: string) => {
				signal.throwIfAborted();
				const admitted = store.readSnapshot((db) =>
					current(db, work.id, jobId),
				);
				const before =
					host.works?.current(work.works) &&
					digest(work) === work.dependency.inputDigest;
				const path = versionFile(work.works);
				const resumed =
					alreadyPublished &&
					digest(work, path) === work.dependency.sourceDigest &&
					host.works?.dependencies?.advanced?.(
						work.works,
						work.dependency.manifest,
						alreadyPublished,
					);
				if (!admitted || (!before && !resumed))
					throw new Error("prototype_dependency_inputs_changed");
			};
			try {
				return {
					version: await host.works!.dependencies!.publish({
						target: work.works,
						approval: work.dependency,
						signal,
						assertCurrent,
					}),
				};
			} catch (error) {
				const reason =
					error instanceof Error && /^prototype_[a-z_]+$/.test(error.message)
						? error.message
						: "prototype_dependency_install_failed";
				return { reason };
			}
		},
		settleInTransaction(db, claim, _input, outcome) {
			const host = getHost();
			const work = current(db, claim.payload.id, claim.jobId);
			if (!host || !work) return "stale";
			const result =
				outcome.type === "success"
					? outcome.result
					: { reason: "prototype_dependency_install_failed" };
			const approval = work.dependency;
			let reason = result.reason;
			if (result.version) {
				try {
					if (digest(work, versionFile(work.works)) !== approval.sourceDigest)
						throw new Error("prototype_dependency_inputs_changed");
					work.works = host.works!.dependencies!.advance(
						work.works,
						approval.manifest,
						result.version,
					);
					work.supervision!.authorization = worksAuthorization(
						work.works,
						work.deadline,
					);
					work.supervision!.evidence = [];
					work.observation = null;
					work.previousId = null;
					work.generation++;
					work.status = "deciding";
					work.summary = `固定版 ${result.version} を導入しました。同じ仕事を再開します。`;
					work.memo = `${approval.request.name}@${approval.request.version} が承認・導入されました。固定版 ${result.version} に更新済みです。元の依頼を再開し、登録済みの検査を両方実行してください。`;
				} catch {
					reason = "prototype_dependency_inputs_changed";
				}
			}
			if (reason)
				finish(
					db,
					host,
					work,
					"partial",
					`共有依存を追加できませんでした (${reason})。`,
				);
			delete (work as Work).dependency;
			work.notice = newId();
			work.observedAt = now();
			save(db, work, now());
			return "applied";
		},
		cancelInTransaction() {},
		afterCommit: () => kick(),
	});
}
