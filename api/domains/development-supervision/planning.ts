import type { Database } from "bun:sqlite";
import { hash } from "../capabilities";
import { bindingCurrent, issueGrant } from "./authority";
import type {
	SupervisionDesignPreparation,
	SupervisionHost,
	SupervisionNote,
} from "./contracts";
import { notesOf, type PlanDecision } from "./decisions";
import { grantOf, saveGrant, saveParent } from "./repository";
import { executionEnded, type Parent } from "./state";
import { finishTask, result } from "./views";
import { allowedScope, plannedTask } from "./work";

export function planningHeld(parent: Parent, reason: string) {
	const task = parent.tasks.find(({ id }) => id === parent.pendingTaskId);
	if (task) {
		finishTask(task, "partial", reason);
		parent.pendingTaskId = null;
		parent.phase = "active";
	} else parent.phase = "held";
	parent.reason = reason;
}

export function applyPlan(
	host: SupervisionHost,
	db: Database,
	parent: Parent,
	plan: PlanDecision,
) {
	if (plan.action === "hold") {
		planningHeld(parent, plan.reason);
		return;
	}
	if (plan.action === "research") {
		if (
			parent.research.length + plan.questions.length >
			parent.limits.research
		) {
			planningHeld(
				parent,
				"調査の上限に達しました。残りの判断には新しい根拠が必要です。",
			);
			return;
		}
		const previous = new Set(
			parent.research.map(
				({ grantRef, kind }) =>
					`${kind}:${grantOf(db, grantRef)?.source.digest}`,
			),
		);
		const fresh = plan.questions.flatMap((question) => {
			const marker = `${question.kind}:${hash(question.request)}`;
			if (previous.has(marker)) return [];
			previous.add(marker);
			const target = host.research.targetInTransaction(db, question.kind);
			return target ? [{ ...question, target }] : [];
		});
		if (!fresh.length) {
			planningHeld(
				parent,
				"新しい調査条件または利用できる調査先を確認できません。",
			);
			return;
		}
		parent.phase = "research";
		parent.reason = "設計のための調査中";
		for (const { request, kind, target } of fresh) {
			const previousCount = parent.research.length;
			try {
				db.transaction(() => {
					const grant = issueGrant(db, parent, {
						...target,
						kind,
						request,
						scope: {
							...parent.workspace,
							mode: "read",
							deadline: parent.deadline,
							readablePaths: [],
							writablePaths: [],
							checks: [],
						},
						design: null,
					});
					parent.research.push({
						kind,
						grantRef: grant.source.delegation.grantRef,
						note: null,
						settled: false,
					});
					saveParent(db, parent, true);
					const started = host.research.startInTransaction(db, kind, {
						...target,
						source: grant.source,
						operationId: grant.operationId,
						request,
						references: [],
						deadline: parent.deadline,
					});
					grant.workId = started.id;
					saveGrant(db, grant);
				})();
			} catch {
				parent.research.length = previousCount;
			}
		}
		if (!parent.research.some((entry) => !entry.settled))
			planningHeld(parent, "調査の受付を確認できません。");
		return;
	}
	const task = parent.tasks.find(({ id }) => id === parent.pendingTaskId);
	if (host.research.skillSmith && !plan.guideQuery) {
		planningHeld(
			parent,
			"設計を確定する前に参照する手順の問い合わせを確認できません。",
		);
		return;
	}
	if (
		(plan.mode === "execute" &&
			(!plan.proposals.length ||
				(parent.ceiling === "design" && !task?.ceiling))) ||
		(plan.mode === "review" && (plan.proposals.length > 0 || !!task)) ||
		(!!task &&
			(plan.proposals.length !== 1 || plan.proposals[0]?.after !== null)) ||
		plan.proposals.some(({ after }, index) => after !== null && after >= index)
	) {
		planningHeld(
			parent,
			"作業の順序または元の依頼で認められた範囲を確認できません。",
		);
		return;
	}
	if (
		task &&
		!task.replanChangedInput &&
		hash(task.proposal) === hash(plan.proposals[0])
	) {
		planningHeld(parent, "再試行に必要な条件の変化を確認できません。");
		return;
	}
	const proposals = plan.proposals.map((proposal, i) => ({
		proposal,
		task: i === 0 ? task : undefined,
	}));
	const tasks = proposals.map(({ proposal, task: prior }) =>
		plannedTask(proposal, prior?.dependsOn ?? null, prior),
	);
	proposals.forEach(({ proposal }, index) => {
		if (proposal.after !== null)
			tasks[index]!.dependsOn = tasks[proposal.after]!.id;
	});
	if (
		tasks.some(
			(candidate) =>
				!allowedScope(parent, candidate) ||
				(candidate.proposal.verification &&
					!allowedScope(parent, candidate, {
						...candidate.proposal,
						...candidate.proposal.verification,
					})),
		)
	) {
		planningHeld(
			parent,
			"元の依頼から、作業または後続の検証に必要な許可を確認できません。",
		);
		return;
	}
	parent.tasks = task
		? parent.tasks.map((entry) => (entry.id === task.id ? tasks[0]! : entry))
		: tasks;
	parent.plan = {
		title: plan.title,
		analysis: plan.analysis,
		mode: plan.mode,
		proposals: plan.proposals,
		...(plan.guideQuery ? { guideQuery: plan.guideQuery } : {}),
	};
	parent.reason = "設計書を作成中";
	parent.phase = "design";
}

export function observeResearch(
	host: SupervisionHost,
	db: Database,
	parent: Parent,
) {
	for (const research of parent.research) {
		if (research.settled) continue;
		const grant = grantOf(db, research.grantRef);
		const view = grant && host.research.viewInTransaction(db, grant);
		if (
			!grant ||
			!view ||
			view.id !== grant.workId ||
			view.conversationId !== parent.source.conversationId ||
			!executionEnded(view.status)
		)
			continue;
		research.note =
			view.status === "completed" || view.status === "partial"
				? host.research.noteInTransaction(db, grant, view)
				: null;
		research.settled = true;
		grant.released = true;
		saveGrant(db, grant);
	}
	if (parent.research.every(({ settled }) => settled)) {
		parent.phase = "plan";
		parent.reason = "調査結果を確認中";
	}
}

export function adoptDesign(
	host: SupervisionHost,
	db: Database,
	parent: Parent,
	prepared: SupervisionDesignPreparation,
	guides: SupervisionNote[],
) {
	if (parent.source.origin === "goal") return;
	const source = parent.source;
	if (prepared.kind !== "ready") {
		planningHeld(parent, prepared.reason);
		return;
	}
	const allowed = [...notesOf(parent), ...guides].map(({ evidence }) =>
		hash(evidence),
	);
	if (
		prepared.evidence.some(
			(evidence) =>
				!allowed.includes(hash(evidence)) ||
				!host.research.validEvidenceInTransaction(db, source, evidence),
		)
	) {
		planningHeld(parent, "設計に使った出典を確認できません。");
		return;
	}
	const binding = {
		parentId: parent.id,
		conversationId: source.conversationId,
		sourceRunId: parent.source.runId,
		generation: parent.generation,
		revision: (parent.designs.at(-1)?.revision ?? 0) + 1,
		documentId: crypto.randomUUID(),
		digest: prepared.digest,
		evidence: prepared.evidence,
	};
	try {
		db.transaction(() => {
			parent.designs.push(binding);
			if (guides.length) parent.context.push(...guides);
			parent.phase = "waiting_design";
			parent.reason = "設計書の保存確認中";
			saveParent(db, parent, true);
			host.design.startInTransaction(db, binding, prepared);
		})();
	} catch {
		parent.designs.pop();
		planningHeld(parent, "設計書の保存を開始できませんでした。");
	}
}

export function inspectDesign(
	host: SupervisionHost,
	db: Database,
	parent: Parent,
) {
	const saved = parent.designs.at(-1);
	if (!saved || !bindingCurrent(host, db, parent, saved)) {
		planningHeld(parent, "設計書または設計の根拠を確認できません。");
		return;
	}
	const status = host.design.stateInTransaction(db, saved);
	if (status === "pending") return;
	const ready = status === "ready" && host.design.readInTransaction(db, saved);
	if (
		!ready ||
		ready.documentId !== saved.documentId ||
		ready.digest !== saved.digest
	) {
		planningHeld(parent, "設計書の保存と本文の版を確認できません。");
		return;
	}
	parent.designUris[saved.documentId] = ready.uri;
	if (parent.plan?.mode === "review") {
		parent.result = {
			...result("completed", "設計書を保存しました。", [saved.documentId]),
			links: [ready.uri],
		};
		parent.phase = "finished";
		return;
	}
	for (const task of parent.tasks) {
		if (task.designRevision !== null || task.phase !== "dispatch") continue;
		task.designRevision = saved.revision;
		task.reason = "実行枠の確認待ち";
	}
	parent.pendingTaskId = null;
	parent.phase = "active";
	parent.reason = "開発作業の進捗を確認中";
}
