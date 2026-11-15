import type { Database } from "bun:sqlite";
import type { ExecutionView } from "../tool-runtime";
import type { Decision, Host, Observation, Work } from "./contracts";
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
	if (work.notice) host.revokeInTransaction(db, work.notice);
	if (work.deliveredNotice) host.revokeInTransaction(db, work.deliveredNotice);
	work.notice = null;
	work.deliveredNotice = undefined;
	work.question = null;
	work.questionFromRunner = false;
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
		work.effect = { kind: "stop", id: newId(), reason };
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
	if (observation.executionId !== work.executionId) return false;
	if (!effect && work.observation && observation.seq <= work.observation.seq)
		return false;
	work.effect = null;
	work.observation = observation;
	if (observation.state === "waiting" && observation.question) {
		work.status = "waiting_user";
		if (work.question?.id !== observation.question.id) {
			closeQuestion(db, host, work);
			work.question = observation.question;
			work.questionFromRunner = true;
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
	} else {
		closeQuestion(db, host, work);
		work.status = "waiting_child";
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
			work.executionId = newId();
			work.executions++;
			work.turnsUsedBeforeExecution = work.turnsReserved;
			work.turnsReserved += maxTurns;
			work.status = "waiting_child";
			work.stop = undefined;
			work.effect = {
				kind: "start",
				operation: {
					id: work.executionId,
					workId: work.id,
					generation: work.generation,
					instruction: decision.instruction,
					priorExecutionId: work.previousId,
					deadline: work.deadline,
					maxTurns,
					readOnly: work.mode === "analysis",
				},
			};
			return;
		}
		case "ask_user":
			work.status = "waiting_user";
			work.question = {
				id: newId(),
				prompt: decision.question,
				expiresAt: Math.min(work.deadline, now + 15 * 60_000),
				inputSchema: { type: "string", maxLength: 2_000 },
			};
			work.notice = newId();
			return;
		case "finish": {
			const known = new Set(work.observation?.evidence?.map(({ ref }) => ref));
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
			finish(
				db,
				host,
				work,
				"partial",
				"追加の観測が得られず、作業を中断しました。",
			);
	}
}

export function authorityCurrent(host: Host, db: Database, work: Work) {
	return (
		host.validSourceInTransaction(db, work.source) &&
		work.references.every((reference) =>
			host.validReferenceInTransaction(db, work.source, reference),
		)
	);
}
