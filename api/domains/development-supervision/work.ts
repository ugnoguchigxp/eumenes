import type { Database } from "bun:sqlite";
import { isAbsolute, relative, sep } from "node:path";
import { hash } from "../capabilities";
import { childObservation, designFor, issueGrant } from "./authority";
import type {
	SupervisionChildObservation,
	SupervisionHost,
	SupervisionScope,
	SupervisionWorkspaceEvidence,
} from "./contracts";
import { type Judgement, type Proposal } from "./decisions";
import { earlierGoalEdit, rememberGoalEdit } from "./goal-edits";
import { recordQuestion } from "./questions";
import {
	grantOf,
	grantsOf,
	questionsOf,
	saveGrant,
	saveParent,
} from "./repository";
import {
	executionEnded,
	taskOutcome,
	type Grant,
	type Parent,
	type Task,
} from "./state";
import { finishTask } from "./views";

export function plannedTask(
	proposal: Proposal,
	dependsOn: string | null,
	previous?: Task,
): Task {
	return {
		id: previous?.id ?? crypto.randomUUID(),
		revision: previous?.revision ?? 0,
		generation: previous?.generation ?? 0,
		ceiling: previous?.ceiling ?? null,
		proposal,
		dependsOn,
		designRevision: null,
		phase: "dispatch",
		state: "waiting",
		reason: "設計書の保存確認中",
		result: null,
		outcome: null,
		grantRef: null,
		before: null,
		readEvidence: [],
		replanEvidence: previous?.replanEvidence ?? [],
		replanChangedInput: false,
		evidence: [],
		jobId: null,
		dispatchFailed: false,
	};
}

export function scopeOf(parent: Parent, task: Task): SupervisionScope {
	if (parent.goalScope) return parent.goalScope;
	const { mode, readablePaths, writablePaths, checks } = task.proposal;
	return {
		...parent.workspace,
		mode,
		deadline: parent.deadline,
		readablePaths,
		writablePaths,
		checks,
	};
}

export function allowedScope(
	parent: Parent,
	task: Task,
	proposal = task.proposal,
) {
	const ceiling = task.ceiling ?? parent.ceiling;
	const modes = ["design", "read", "verify", "edit"] as const;
	if (!ceiling || modes.indexOf(proposal.mode) > modes.indexOf(ceiling))
		return false;
	if (proposal.mode !== "edit" && proposal.writablePaths.length) return false;
	if (proposal.mode === "read") return proposal.checks.length === 0;
	if (
		!proposal.checks.length ||
		(proposal.mode === "edit" && !proposal.writablePaths.length)
	)
		return false;
	if (parent.goalScope) return true;
	const quote = proposal.authorityQuote.trim();
	return (
		!!quote &&
		[
			parent.source.request,
			...(parent.confirmation ? [parent.confirmation.request] : []),
			...parent.controls
				.filter(({ taskId }) => !taskId || taskId === task.id)
				.map(({ text, source }) => source?.request ?? text),
		].some((text) => text.includes(quote))
	);
}

export function workHold(task: Task, reason: string, blockerRef?: string) {
	task.state = "held";
	task.reason = reason;
	if (blockerRef) task.blockerRef = blockerRef;
	else delete task.blockerRef;
}

export function releaseConfirmed(
	host: SupervisionHost,
	db: Database,
	grant: Grant,
	child: SupervisionChildObservation | null,
) {
	return (
		!!child &&
		executionEnded(child.view.status) &&
		child.releaseConfirmed &&
		host.workspace.inspectInTransaction(
			db,
			grant.scope,
			grant.workId ?? undefined,
		).released === true
	);
}

export function revokeGrant(host: SupervisionHost, db: Database, grant: Grant) {
	grant.revoked = true;
	if (!grant.released && grant.workId)
		grant.stopOperationId ??= crypto.randomUUID();
	saveGrant(db, grant);
	if (!grant.stopOperationId || !grant.workId || grant.released) return;
	if (grant.kind === "claude")
		host.child.cancelInTransaction(db, grant.source, grant.workId, {
			operationId: grant.stopOperationId,
		});
	else {
		host.research.cancelInTransaction(db, grant, grant.stopOperationId);
		grant.released = true;
		saveGrant(db, grant);
	}
}

export function hasOldWork(
	host: SupervisionHost,
	db: Database,
	parent: Parent,
	task?: Task,
) {
	let holding = false;
	for (const grant of grantsOf(db, parent.id)) {
		if (
			!grant.revoked ||
			grant.released ||
			!grant.workId ||
			(task && grant.source.delegation.taskId !== task.id)
		)
			continue;
		if (grant.kind !== "claude") continue;
		const view = childObservation(host, db, grant);
		if (releaseConfirmed(host, db, grant, view)) {
			grant.released = true;
			saveGrant(db, grant);
		} else holding = true;
	}
	return holding;
}

export type ScheduleTask = (kind: "capture" | "judge", task: Task) => void;

function dispatch(
	host: SupervisionHost,
	db: Database,
	parent: Parent,
	task: Task,
	schedule: ScheduleTask,
) {
	const dependency = parent.tasks.find(({ id }) => id === task.dependsOn);
	if (dependency && dependency.outcome !== "succeeded") {
		if (dependency.phase === "finished")
			workHold(task, "先行タスクが受入条件を満たしていません。", dependency.id);
		else {
			task.state = "waiting";
			task.reason = "先行タスクの受入待ち";
			task.blockerRef = dependency.id;
		}
		return;
	}
	const requiresDesign = !parent.goalScope || parent.goalScope.mode === "edit";
	if (
		(requiresDesign && !task.designRevision) ||
		parent.pendingTaskId === task.id ||
		task.dispatchFailed
	)
		return;
	const design = designFor(host, db, parent, task.designRevision);
	if (!design && requiresDesign) {
		finishTask(task, "interrupted", "設計書または設計の根拠を確認できません。");
		return;
	}
	const proposed = scopeOf(parent, task);
	const scope = host.workspace.resolveScope
		? host.workspace.resolveScope(proposed)
		: proposed;
	if (
		!scope ||
		!allowedScope(parent, task) ||
		!host.workspace.authorizeInTransaction(db, {
			source: parent.source,
			parentRequest: parent.request,
			ceiling: (task.ceiling ?? parent.ceiling)!,
			scope,
			authorityQuote: task.proposal.authorityQuote,
			design,
		})
	) {
		workHold(
			task,
			"対象と操作の許可を確認できません。現行の条件では実行を開始できません。",
		);
		return;
	}
	const workspace = host.workspace.inspectInTransaction(
		db,
		scope,
		undefined,
		earlierGoalEdit(db, parent, scope),
	);
	if (workspace.reason) {
		if (workspace.blockerRef)
			workHold(task, workspace.reason, workspace.blockerRef);
		else {
			task.state = "waiting";
			task.reason = workspace.reason;
			delete task.blockerRef;
		}
		task.before = null;
		return;
	}
	const target = host.child.targetInTransaction(
		db,
		!!parent.goalScope,
		parent.goalScope?.workspaceRef,
	);
	if (!target) {
		if (parent.goalScope)
			finishTask(task, "failed", "Claude Code の受付を確認できません。");
		else workHold(task, "Claude Code の受付を確認できません。");
		return;
	}
	if (parent.childCalls >= parent.limits.children) {
		finishTask(
			task,
			"partial",
			"実行枠の上限に達しました。再開には新しい作業依頼が必要です。",
		);
		return;
	}
	if (!task.before) {
		task.state = "running";
		task.reason = "対象の版と既存差分を確認中";
		schedule("capture", task);
		return;
	}
	const request = `${design ? design.markdown + "\n\n" : ""}## 作業範囲\n${task.proposal.instruction}\n\n## 受入条件\n${task.proposal.acceptance.map((item) => `- ${item}`).join("\n")}`;
	const previous = task.grantRef;
	try {
		db.transaction(() => {
			const grant = issueGrant(db, parent, {
				...target,
				kind: "claude",
				request,
				scope: { ...scope, baselineInputDigest: task.before!.inputDigest },
				design: design
					? {
							revision: task.designRevision!,
							documentId: design.documentId,
							digest: design.digest,
						}
					: null,
				task,
			});
			task.grantRef = grant.source.delegation.grantRef;
			saveParent(db, parent, true);
			const child = host.child.startInTransaction(db, {
				...target,
				operationId: grant.operationId,
				source: grant.source,
				request,
				references: parent.references,
				deadline: scope.deadline,
			});
			grant.workId = child.id;
			saveGrant(db, grant);
		})();
	} catch (error) {
		task.grantRef = previous;
		const code = error instanceof Error ? error.message : "unknown";
		if (code === "claude_workspace_busy") {
			task.state = "waiting";
			task.before = null;
			task.reason = scope.mode === "read" ? "読取り枠待ち" : "編集枠待ち";
		} else if (code === "queue_full") workHold(task, "実行キューの空き待ち");
		else {
			task.dispatchFailed = true;
			workHold(
				task,
				code === "claude_request_invalid"
					? "設計と作業範囲・受入条件を含む依頼書が実行指示の上限を超えています。範囲を分けて依頼してください。"
					: "子仕事の受付を確認できません。再開には新しい条件が必要です。",
			);
		}
		return;
	}
	parent.childCalls++;
	task.phase = "child";
	task.state = "waiting";
	task.reason = "子仕事の開始待ち";
	delete task.blockerRef;
}

export function inspectTask(
	host: SupervisionHost,
	db: Database,
	parent: Parent,
	task: Task,
	schedule: ScheduleTask,
) {
	if (task.phase === "finished") return;
	if (
		hasOldWork(host, db, parent, task) ||
		grantsOf(db, parent.id).some(
			(grant) =>
				grant.revoked &&
				!grant.released &&
				grant.source.delegation.parentGeneration < parent.generation,
		)
	) {
		workHold(task, "旧実行の停止確認中");
		return;
	}
	if (task.jobId || task.phase === "replan") return;
	if (task.phase === "dispatch") {
		dispatch(host, db, parent, task, schedule);
		return;
	}
	const grant = task.grantRef && grantOf(db, task.grantRef);
	const child = grant ? childObservation(host, db, grant) : null;
	if (!grant || !child) {
		workHold(task, "子仕事の現在の状態を確認できません。");
		return;
	}
	if (child.view.question) recordQuestion(db, parent, grant, child);
	if (child.view.stop === "unconfirmed" || child.view.status === "stopping") {
		workHold(
			task,
			child.view.stop === "unconfirmed" ? "自分の停止未確認" : "停止確認中",
		);
		return;
	}
	if (executionEnded(child.view.status)) {
		if (!releaseConfirmed(host, db, grant, child)) {
			workHold(task, "子仕事の停止と実行枠の解放を確認中");
			return;
		}
		if (!grant.released) {
			grant.released = true;
			saveGrant(db, grant);
		}
		if (parent.goalScope && grant.scope.mode !== "edit") {
			const observed = goalEvidenceOf(grant, child);
			const failed = observed.find(
				({ kind, passed }) => kind === "check" && passed === false,
			);
			if (failed || child.view.status !== "completed") {
				task.evidence = observed;
				finishTask(
					task,
					"failed",
					failed
						? [
								failed.exitCode === undefined
									? null
									: `終了コード ${failed.exitCode}`,
								failed.stderr ? "標準エラー " + failed.stderr : failed.text,
							]
								.filter(Boolean)
								.join("\n")
						: (child.view.result?.summary ?? task.reason),
					observed.map(({ ref }) => ref),
				);
				return;
			}
			if (!task.designRevision) {
				task.evidence = observed;
				finishTask(
					task,
					observed.length ? "completed" : "partial",
					child.view.result?.summary ?? task.reason,
					observed.map(({ ref }) => ref),
				);
				return;
			}
		}
		task.phase = "evaluate";
		task.state = child.view.status === "completed" ? "running" : "held";
		task.reason =
			child.view.status === "completed" ? "受入確認中" : "検証失敗・再計画中";
		schedule("judge", task);
		return;
	}
	if (child.view.status === "queued") {
		const workspace = host.workspace.inspectInTransaction(
			db,
			grant.scope,
			grant.workId ?? undefined,
		);
		if (workspace.blockerRef) {
			workHold(
				task,
				workspace.reason ?? "他タスクの停止未確認",
				workspace.blockerRef,
			);
			return;
		}
		if (child.blocking?.state === "held") {
			workHold(task, child.blocking.reason);
			return;
		}
		task.state = "waiting";
		task.reason =
			workspace.reason ?? child.blocking?.reason ?? "子仕事の開始待ち";
		delete task.blockerRef;
		return;
	}
	if (child.view.status === "waiting_user") {
		const shown = questionsOf(db, parent.id).some(
			({ id, grantRef }) =>
				id === parent.question?.id && grantRef === task.grantRef,
		);
		workHold(task, shown ? "利用者の回答待ち" : "質問の提示待ち");
		return;
	}
	task.state = "running";
	task.reason =
		child.view.progress?.summary ||
		(task.proposal.mode === "read"
			? "静的読解中"
			: task.proposal.mode === "verify"
				? "検証中"
				: "実装中");
	delete task.blockerRef;
}

export function evidenceOf(grant: Grant, child: SupervisionChildObservation) {
	const { mode, targetRevision, readablePaths, writablePaths, checks } =
		grant.scope;
	return child.evidence.filter(
		(item) =>
			item.executionId === child.executionId &&
			item.targetRevision === targetRevision &&
			((item.kind === "read" &&
				!!item.path &&
				readablePaths.some((root) => {
					const rel = relative(root, item.path!);
					return (
						rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
					);
				})) ||
				(item.kind === "edit" &&
					mode === "edit" &&
					!!item.path &&
					writablePaths.includes(item.path)) ||
				(item.kind === "check" &&
					mode !== "read" &&
					!!item.check &&
					checks.some((check) => hash(check) === hash(item.check)))),
	);
}

function goalEvidenceOf(grant: Grant, child: SupervisionChildObservation) {
	const evidence = new Map(
		evidenceOf(grant, child).map((item) => [item.ref, item]),
	);
	for (const check of child.diagnosticChecks ?? []) {
		if (
			check.kind === "check" &&
			check.passed === false &&
			check.check &&
			check.targetRevision === grant.scope.targetRevision &&
			grant.scope.checks.some((allowed) => hash(allowed) === hash(check.check))
		)
			evidence.set(check.ref, check);
	}
	return [...evidence.values()];
}

export function applyJudgement(
	parent: Parent,
	task: Task,
	grant: Grant,
	child: SupervisionChildObservation,
	observation: SupervisionWorkspaceEvidence,
	decision: Judgement,
) {
	const evidence = evidenceOf(grant, child);
	task.evidence = parent.goalScope ? goalEvidenceOf(grant, child) : evidence;
	rememberGoalEdit(parent, task, grant, observation, evidence);
	if (decision.action === "finish") {
		const outcome =
			child.view.status === "cancelled" || child.view.status === "interrupted"
				? taskOutcome(child.view.status)
				: decision.status;
		finishTask(
			task,
			outcome === "succeeded" ? "partial" : outcome,
			decision.reason,
		);
		return;
	}
	const cited = evidence.filter(({ ref }) => decision.refs.includes(ref));
	const refs = cited.map(({ ref }) => ref);
	if (new Set(refs).size !== new Set(decision.refs).size || !grant.released) {
		finishTask(
			task,
			"partial",
			"同じ子仕事・実行の現行証跡として確認できません。",
		);
		return;
	}
	if (decision.action === "replan") {
		if (parent.goalScope) {
			finishTask(task, "partial", decision.reason, refs);
			return;
		}
		const fingerprint = hash([
			observation.inputDigest,
			cited
				.map(({ kind, targetRevision, inputDigest, path, passed, check }) => ({
					kind,
					targetRevision,
					inputDigest,
					path,
					passed,
					check,
				}))
				.map(hash)
				.sort(),
		]);
		if (task.replanEvidence.includes(fingerprint) || !refs.length) {
			finishTask(task, "partial", "新しい再計画の根拠を確認できません。", refs);
			return;
		}
		task.replanEvidence.push(fingerprint);
		task.replanChangedInput =
			task.before?.inputDigest !== observation.inputDigest ||
			!!observation.staleReadRefs?.length;
		task.result = {
			status: "partial",
			summary: decision.reason,
			refs,
			missing: [],
			fulfilled: [],
		};
		task.phase = "replan";
		workHold(task, `再計画中 · ${decision.reason}`);
		return;
	}
	if (observation.staleReadRefs?.length) {
		finishTask(
			task,
			"partial",
			"先行する静的読解の対象が変わったため、読み直しが必要です。",
			refs,
		);
		return;
	}
	if (
		!observation.preserved ||
		observation.targetRevision !== grant.scope.targetRevision ||
		child.view.status !== "completed"
	) {
		finishTask(
			task,
			"partial",
			"対象の版、既存差分または子仕事の完了を確認できません。",
			refs,
		);
		return;
	}
	const read =
		grant.scope.mode === "read" &&
		cited.some(
			(item) =>
				item.kind === "read" && item.inputDigest === observation.inputDigest,
		);
	if (decision.action === "verify") {
		const next = task.proposal.verification;
		if (
			!read ||
			!next ||
			!allowedScope(parent, task, { ...task.proposal, ...next })
		) {
			finishTask(
				task,
				"partial",
				"読取りの証跡または続く検証の許可を確認できません。",
				refs,
			);
			return;
		}
		task.readEvidence = [...task.readEvidence, ...cited];
		task.evidence = [];
		task.proposal = { ...task.proposal, ...next, verification: null };
		task.grantRef = null;
		task.before = null;
		task.phase = "dispatch";
		task.state = "waiting";
		task.reason = "編集枠待ち";
		return;
	}
	// Receipts are in execution order. A later change can restore the same bytes,
	// and the same check can fail on a retry without changing any files.
	const lastEdit = evidence.findLastIndex((item) => item.kind === "edit");
	const afterEdit = evidence.slice(lastEdit + 1);
	const latestChecks = grant.scope.checks.map((check) =>
		afterEdit.findLast(
			(item) => item.kind === "check" && hash(item.check) === hash(check),
		),
	);
	const verified =
		latestChecks.length > 0 &&
		latestChecks.every(
			(latest) =>
				latest?.passed === true &&
				latest.inputDigest === observation.inputDigest &&
				refs.includes(latest.ref),
		);
	const edit = evidence[lastEdit];
	const edited =
		task.before?.inputDigest !== observation.inputDigest &&
		edit?.inputDigest === observation.inputDigest &&
		refs.includes(edit.ref);
	const sufficient =
		read ||
		(grant.scope.mode === "verify" && verified) ||
		(grant.scope.mode === "edit" && edited && verified);
	finishTask(
		task,
		sufficient ? "completed" : "partial",
		sufficient
			? decision.reason
			: "現行の対象版で受入条件を確認できる実行証跡が不足しています。",
		sufficient
			? refs
			: [
					...(edited ? [edit.ref] : []),
					...latestChecks.flatMap((item) =>
						item?.inputDigest === observation.inputDigest ? [item.ref] : [],
					),
				],
	);
}
