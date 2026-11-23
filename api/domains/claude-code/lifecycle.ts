import type { Database } from "bun:sqlite";
import {
	isStandardExecutionSource,
	isSupervisedExecutionSource,
	type ExecutionView,
} from "../tool-runtime";
import { codingCanonicalJSON } from "../coding";
import type {
	Decision,
	Host,
	Observation,
	SupervisedAuthority,
	Work,
} from "./contracts";
import { terminal } from "./repository";

export const newId = () => crypto.randomUUID();
export function view(work: Work): ExecutionView {
	return {
		id: work.id,
		conversationId: work.source.conversationId,
		request: work.request,
		revision: work.revision,
		deadline: work.deadline,
		status: work.status,
		question: work.question,
		result: work.result,
		stop: work.stop,
		progress: { summary: work.summary, observedAt: work.observedAt },
		conversationSummary: work.conversationSummary,
	};
}

export function closeQuestion(db: Database, host: Host, work: Work) {
	if (!work.supervision) {
		if (work.notice) host.revokeInTransaction(db, work.notice);
		if (work.deliveredNotice)
			host.revokeInTransaction(db, work.deliveredNotice);
	} else work.supervision.presentation = undefined;
	work.notice = null;
	work.deliveredNotice = undefined;
	work.question = null;
	work.questionFromRunner = false;
	work.pendingRunnerQuestion = null;
}

export function escalatePendingQuestion(work: Work, prompt?: string) {
	const pending = work.pendingRunnerQuestion;
	if (!pending) return false;
	work.pendingRunnerQuestion = null;
	work.question = {
		...pending,
		...(prompt ? { prompt } : {}),
	};
	work.questionFromRunner = true;
	work.status = "waiting_user";
	work.summary =
		pending.kind === "permission"
			? "Claude Code の追加操作について利用者の許可を待っています。"
			: "Claude Code からの質問に対する利用者の回答を待っています。";
	work.notice = newId();
	return true;
}

function recordKnownEvidence(work: Work, observation: Observation) {
	const refs = new Set(work.knownEvidenceRefs ?? []);
	for (const item of observation.evidence ?? []) refs.add(item.ref);
	for (const item of observation.structuredEvidence ?? []) refs.add(item.ref);
	if (refs.size) work.knownEvidenceRefs = [...refs].slice(-128);
}

function describeRunningProgress(observation: Observation): string | null {
	const tool = observation.lastTool?.trim();
	const count = observation.eventCount;
	if (tool && typeof count === "number" && count > 0)
		return `Claude Code が実行中です（直近操作: ${tool} / イベント ${count} 件）。`;
	if (tool) return `Claude Code が実行中です（直近操作: ${tool}）。`;
	if (typeof count === "number" && count > 0)
		return `Claude Code が実行中です（イベント ${count} 件）。`;
	return null;
}

export function finish(
	db: Database,
	host: Host,
	work: Work,
	status: NonNullable<Work["result"]>["status"],
	summary: string,
	result: Pick<
		NonNullable<Work["result"]>,
		"fulfilled" | "missing" | "refs"
	> = {
		fulfilled: [],
		missing: [],
		refs: [],
	},
) {
	closeQuestion(db, host, work);
	if (work.supervision?.answerDelivery?.state === "pending")
		work.supervision.answerDelivery.state = "failed";
	work.status = status;
	work.summary = summary;
	work.result = { status, summary, ...result };
	work.notice = work.forgotten ? null : newId();
	work.effect = null;
	work.decisionId = null;
	if (work.holdsWorkspace) {
		host.workspace.release(
			db,
			work.id,
			!work.executionId || work.stop === "confirmed",
			work.supervision?.lease,
		);
		work.holdsWorkspace = false;
	}
}

export function requestStop(
	db: Database,
	host: Host,
	work: Work,
	reason: Extract<NonNullable<Work["effect"]>, { kind: "stop" }>["reason"],
	now: number,
	operationId: string = newId(),
) {
	if (terminal(work)) return;
	if (work.effect?.kind === "stop" && work.effect.reason === reason) return;
	closeQuestion(db, host, work);
	work.generation++;
	work.decisionId = null;
	if (work.executionId) {
		work.status = "stopping";
		work.stop = "requested";
		work.stopAt ??= now + 15_000;
		work.summary = "Claude Codeの停止を確認しています。";
		work.effect = { kind: "stop", id: operationId, reason };
		return;
	}
	if (reason === "amend") {
		work.status = "deciding";
		return;
	}
	work.stop = "confirmed";
	finish(
		db,
		host,
		work,
		reason === "expired" ? "failed" : "cancelled",
		reason === "expired" ? "作業期限に達しました。" : "作業を取り消しました。",
	);
}

export function acceptObservation(
	db: Database,
	host: Host,
	work: Work,
	observation: Observation | null,
) {
	const effect = work.effect;
	if (observation && observation.executionId !== work.executionId) return false;
	const supervised = work.supervision;
	if (
		supervised &&
		observation &&
		!observation.blocked &&
		(observation.supervised || observation.state !== "stopped") &&
		codingCanonicalJSON(observation.supervised) !==
			codingCanonicalJSON({
				lease: supervised.lease,
				authorization: supervised.authorization,
			})
	)
		return false;
	if (supervised && observation?.blocked) {
		if (effect?.kind !== "start" || supervised.blocked === observation.blocked)
			return false;
		supervised.blocked = observation.blocked;
		work.summary =
			observation.blocked === "verification_isolation_unavailable"
				? "検証用の書込み制限を適用できないため保留しています。"
				: observation.blocked === "workspace_inputs_changed"
					? "承認対象のファイルが変わったため保留しています。"
					: observation.blocked === "runner_quarantined"
						? "他タスクの停止未確認のため起動を保留しています。"
						: "実行枠が空くまで起動を保留しています。";
		work.status = "queued";
		work.notice = newId();
		if (
			observation.blocked === "verification_isolation_unavailable" ||
			observation.blocked === "workspace_inputs_changed"
		) {
			// The runner refused before executing. A new plan may use the freed slot.
			work.effect = null;
			work.executionId = null;
			host.workspace.release(db, work.id, true, supervised.lease);
			work.holdsWorkspace = false;
		}
		return true;
	}
	if (effect?.kind === "stop") {
		if (
			observation &&
			!observation.managedExecutionStopped &&
			observation.state !== "unknown"
		)
			return false;
		const confirmed = observation?.managedExecutionStopped === true;
		work.stop = confirmed ? "confirmed" : "unconfirmed";
		if (!confirmed) {
			finish(
				db,
				host,
				work,
				"interrupted",
				"作業を中断しました。Claude Codeの停止は未確認です。",
			);
			return true;
		}
		if (observation?.canResume) work.previousId = work.executionId;
		work.executionId = null;
		work.effect = null;
		work.stopAt = undefined;
		if (effect.reason === "amend") {
			work.status = "deciding";
			work.observation = null;
		} else
			finish(
				db,
				host,
				work,
				effect.reason === "expired" ? "failed" : "cancelled",
				effect.reason === "expired"
					? "作業期限に達し、実行を停止しました。"
					: "作業を取り消しました。",
			);
		return true;
	}
	if (!observation) {
		work.stop = "unconfirmed";
		finish(
			db,
			host,
			work,
			"interrupted",
			"実行の記録が見つからず、停止を確認できません。",
		);
		return true;
	}
	if (!effect && work.observation && observation.seq <= work.observation.seq)
		return false;
	work.effect = null;
	work.observation = observation;
	recordKnownEvidence(work, observation);
	if (supervised) {
		supervised.blocked = undefined;
		if (observation.structuredEvidence?.length) {
			const references = new Map(
				(supervised.evidence ?? []).map((item) => [item.ref, item]),
			);
			for (const item of observation.structuredEvidence) {
				if (
					item.executionId === observation.executionId &&
					item.targetRevision === supervised.authorization.targetRevision
				)
					references.set(item.ref, item);
			}
			supervised.evidence = [...references.values()].slice(-64);
		}
		if (
			effect?.kind === "reply" &&
			supervised.answerDelivery?.state === "pending"
		)
			supervised.answerDelivery.state = "delivered";
		work.notice = newId();
	}
	if (observation.state === "waiting" && observation.question) {
		const incoming = observation.question;
		if (
			work.question?.id === incoming.id ||
			work.pendingRunnerQuestion?.id === incoming.id
		)
			return true;
		closeQuestion(db, host, work);
		if (!supervised && incoming.kind === "question") {
			work.pendingRunnerQuestion = incoming;
			work.status = "deciding";
			work.summary = "Claude Code からの質問を確認しています。";
		} else {
			work.question = incoming;
			work.questionFromRunner = true;
			work.status = "waiting_user";
			work.summary =
				incoming.kind === "permission"
					? "Claude Code の追加操作について利用者の許可を待っています。"
					: "Claude Code からの質問に対する利用者の回答を待っています。";
			work.notice = newId();
		}
	} else if (observation.state === "unknown") {
		work.stop = "unconfirmed";
		finish(db, host, work, "interrupted", "実行状態を確認できません。");
	} else if (observation.managedExecutionStopped) {
		closeQuestion(db, host, work);
		if (typeof observation.turns === "number")
			work.turnsReserved -= Math.max(
				0,
				Math.min(30, 120 - work.turnsUsedBeforeExecution) - observation.turns,
			);
		if (observation?.canResume) work.previousId = work.executionId;
		work.executionId = null;
		work.stop = "confirmed";
		work.status = "deciding";
		work.summary =
			observation.resultSubtype === "error_max_turns"
				? "ターン上限に達したため、継続の要否を確認しています。"
				: observation.state === "failed"
					? "実行エラーを確認し、次の対応を判断しています。"
					: "Claude Code の実行結果と証跡を確認しています。";
		if (supervised) work.notice = newId();
	} else {
		closeQuestion(db, host, work);
		work.status = "waiting_child";
		const progress = describeRunningProgress(observation);
		if (progress && work.progressSeq !== observation.seq)
			work.summary = progress;
		if (supervised) work.notice = newId();
	}
	return true;
}

export function applyDecision(
	db: Database,
	host: Host,
	work: Work,
	decision: Decision,
	now: number,
) {
	work.summary = decision.summary;
	work.memo = decision.memo;
	if (work.decisionMode === "question" && work.pendingRunnerQuestion) {
		const pending = work.pendingRunnerQuestion;
		if (decision.action === "reply" && pending.kind !== "permission") {
			work.pendingRunnerQuestion = null;
			work.effect = {
				kind: "reply",
				id: newId(),
				questionId: pending.id,
				answer: decision.answer,
			};
			work.answers.push({
				messageId: "supervisor",
				question: pending.prompt,
				answer: decision.answer,
			});
			work.status = "waiting_child";
			work.summary =
				decision.summary ||
				"Claude Code の質問へ回答し、作業を継続しています。";
			return;
		}
		escalatePendingQuestion(
			work,
			decision.action === "ask_user" ? decision.question : undefined,
		);
		return;
	}
	switch (decision.action) {
		case "invoke": {
			const maxTurns = Math.min(30, 120 - work.turnsReserved);
			if (
				work.executionId ||
				work.calls >= work.maxCalls ||
				work.executions >= work.maxExecutions ||
				!maxTurns
			) {
				finish(db, host, work, "partial", "追加実行の上限に達しました。");
				return;
			}
			let instruction = decision.instruction;
			if (work.supervision) {
				const limit = 8_000;
				if (work.request.length > limit) {
					finish(
						db,
						host,
						work,
						"partial",
						"依頼書が実行指示の上限を超えています。",
					);
					return;
				}
				const heading = "\n\n## 今回の実行指示\n";
				const available = limit - work.request.length - heading.length;
				const addition = decision.instruction
					.slice(0, Math.max(0, available))
					.trimEnd();
				instruction = work.request;
				if (decision.instruction !== work.request && addition)
					instruction += heading + addition;
			}
			work.executionId = newId();
			work.executions++;
			work.turnsUsedBeforeExecution = work.turnsReserved;
			work.turnsReserved += maxTurns;
			work.decisionRetries = 0;
			work.eventCursor = 0;
			work.eventExcerpts = [];
			work.status = "waiting_child";
			work.stop = undefined;
			work.effect = {
				kind: "start",
				operation: {
					id: work.executionId,
					workId: work.id,
					generation: work.generation,
					instruction,
					priorExecutionId: work.previousId,
					deadline: work.deadline,
					maxTurns,
					readOnly: work.mode === "analysis",
					...(work.supervision?.lease
						? {
								readOnly: work.supervision.authorization.mode === "read",
								supervised: {
									authorization: work.supervision.authorization,
									lease: work.supervision.lease,
								},
							}
						: {}),
				},
			};
			return;
		}
		case "read_events": {
			const targetId = work.observation?.executionId ?? work.previousId;
			if (
				!targetId ||
				work.executionId ||
				work.calls >= work.maxCalls ||
				work.eventCursor === -1
			) {
				finish(
					db,
					host,
					work,
					"partial",
					"詳細イベントを取得できず、作業を中断しました。",
				);
				return;
			}
			work.effect = {
				kind: "read_events",
				executionId: targetId,
				after: decision.after,
			};
			work.status = "deciding";
			work.summary = "Claude Code の詳細イベントを確認しています。";
			return;
		}
		case "reply": {
			if (!work.supervision && work.calls < work.maxCalls) {
				work.status = "deciding";
				return;
			}
			finish(
				db,
				host,
				work,
				"partial",
				"対象の質問が存在せず、作業を中断しました。",
			);
			return;
		}
		case "ask_user":
			work.status = "waiting_user";
			work.question = {
				id: newId(),
				prompt: decision.question,
				expiresAt: work.supervision
					? work.deadline
					: Math.min(work.deadline, now + 15 * 60_000),
				inputSchema: { type: "string", maxLength: 2_000 },
				...(work.supervision ? { presentation: "waiting" as const } : {}),
			};
			work.notice = newId();
			return;
		case "finish": {
			const known = new Set(
				work.supervision
					? (work.supervision.evidence ?? []).map(({ ref }) => ref)
					: [
							...(work.observation?.evidence ?? []).map(({ ref }) => ref),
							...(work.knownEvidenceRefs ?? []),
						],
			);
			const refs = decision.refs.filter((ref) => known.has(ref));
			const verified =
				decision.status !== "completed" ||
				(refs.length > 0 &&
					refs.length === decision.refs.length &&
					work.observation?.state === "finished");
			finish(
				db,
				host,
				work,
				verified ? decision.status : "partial",
				verified
					? decision.summary
					: "依頼の達成を裏付ける実行証跡が不足しています。",
				{
					fulfilled: decision.fulfilled,
					missing: verified
						? decision.missing
						: [...decision.missing, "実行証跡"],
					refs,
				},
			);
			return;
		}
		case "wait":
			if (work.executionId) {
				work.status = "waiting_child";
				return;
			}
			if (
				!work.supervision &&
				(work.decisionRetries ?? 0) < 2 &&
				work.calls < work.maxCalls
			) {
				work.decisionRetries = (work.decisionRetries ?? 0) + 1;
				work.status = "deciding";
				work.summary = "次の作業判断を再確認しています。";
				return;
			}
			finish(
				db,
				host,
				work,
				"partial",
				"追加の観測が得られず、作業を中断しました。",
			);
	}
}

export function supervisedAuthority(
	host: Host,
	db: Database,
	work: Work,
	action: SupervisedAuthority["action"],
	input: Pick<
		SupervisedAuthority,
		"operationId" | "questionId" | "parentQuestionId" | "messageId"
	> = {},
) {
	if (!work.supervision || !isSupervisedExecutionSource(work.source))
		return null;
	return (
		host.supervised?.authorizeInTransaction(db, {
			source: work.source,
			workId: work.id,
			bindingRevisionId: work.binding,
			toolchainRevisionId: work.supervision.toolchainRevisionId,
			request: work.request,
			action,
			...(input.operationId ? { operationId: input.operationId } : {}),
			...(input.questionId ? { questionId: input.questionId } : {}),
			...(input.parentQuestionId
				? { parentQuestionId: input.parentQuestionId }
				: {}),
			...(input.messageId ? { messageId: input.messageId } : {}),
		}) ?? null
	);
}

export function authorityCurrent(
	host: Host,
	db: Database,
	work: Work,
	action: "continue" | "inspect" = "continue",
) {
	const valid = work.supervision
		? codingCanonicalJSON(supervisedAuthority(host, db, work, action)) ===
			codingCanonicalJSON(work.supervision.authorization)
		: isStandardExecutionSource(work.source) &&
			host.validSourceInTransaction(db, work.source);
	return (
		valid &&
		work.references.every((reference) =>
			host.validReferenceInTransaction(db, work.source, reference),
		)
	);
}
