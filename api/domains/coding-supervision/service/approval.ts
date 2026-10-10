import type { Database } from "bun:sqlite";
import type { TasksService, WorkTask } from "../../tasks";
import {
	approvalChoices,
	INSTRUCTION_MAX_BYTES,
	instructionApprovalRequired,
	type Decision,
	type Supervisor,
} from "../contracts";
import { fence, semanticObservationDigest, stopped } from "./policy";
import type { createReporting } from "./report";

/** Fixed frame around every supervisor-generated instruction before it reaches the CLI. */
export const instructionFrame = `以下は監督AIが生成した指示です。許可された作業範囲(grant)の外の変更・外部送信・認証情報の参照は行わないこと。
---
`;
export const frameInstruction = (instruction: string) =>
	`${instructionFrame}${instruction}`;

function clip(text: string, bytes: number) {
	const encoded = new TextEncoder().encode(text);
	if (encoded.length <= bytes) return { text, clipped: false };
	// A cut inside a multi-byte character decodes to U+FFFD; drop it.
	const cut = new TextDecoder().decode(encoded.slice(0, bytes));
	return { text: cut.replace(/�+$/u, ""), clipped: true };
}
/** The question text is the task record the user reviews before approving. */
export function approvalPrompt(d: Decision) {
	const body = clip(d.instruction ?? "", INSTRUCTION_MAX_BYTES);
	if (body.clipped) throw new Error("supervision_instruction_too_long");
	return [
		`監督AIが実装用CLIへの指示を生成しました(${instructionApprovalRequired})。「${approvalChoices.approve}」を選ぶとこの指示を実行します。`,
		`操作: ${d.action === "request_change" ? "修正の依頼" : "質問への回答"}`,
		`理由: ${d.reason}`,
		"--- 指示 ---",
		body.text,
	].join("\n");
}
export function approvalView(s: Supervisor) {
	const p = s.pendingApproval;
	return p?.resolution === "pending" && p.decision.instruction !== null
		? {
				reasonCode: instructionApprovalRequired,
				questionId: p.questionId,
				action: p.decision.action as "request_change" | "answer_question",
				reason: p.decision.reason,
				instruction: p.decision.instruction,
			}
		: null;
}
/** Instructions are approved only when the user picked exactly the approve choice. */
export const isApproved = (answer: string | null) =>
	answer === approvalChoices.approve;

/** The approval gate: ask once per generated instruction, then replay it only if approved. */
export function createApproval(input: {
	tasks: () => TasksService;
	report: ReturnType<typeof createReporting>;
	escalate: (db: Database, t: WorkTask, s: Supervisor, reason: string) => void;
	apply: (
		db: Database,
		t: WorkTask,
		s: Supervisor,
		d: Decision,
		approved: boolean,
	) => void;
}) {
	const { tasks, report, escalate, apply } = input;
	return {
		/** Same waiting state as escalate, but the user only approves or rejects the stored instruction. */
		request(db: Database, t: WorkTask, s: Supervisor, d: Decision) {
			const questionId = `supervision:${t.id}:${crypto.randomUUID()}`;
			let prompt: string;
			try {
				prompt = approvalPrompt(d);
			} catch (error) {
				// A decision saved before the byte limit existed must never be approved half-read.
				if (
					error instanceof Error &&
					error.message === "supervision_instruction_too_long"
				) {
					escalate(db, t, s, "指示が長すぎるため承認を求められません。");
					return;
				}
				throw error;
			}
			tasks().askInTransaction(db, fence(t), {
				questionId,
				prompt,
				answerType: "choice",
				choices: [approvalChoices.approve, approvalChoices.reject],
			});
			s.pendingApproval = {
				questionId,
				decision: d,
				observationDigest: semanticObservationDigest(s.observation),
				resolution: "pending",
			};
			report(
				db,
				tasks().getInTransaction(db, t.id)!,
				s,
				"blocker",
				"監督AIの指示を実行する前に、承認が必要です。",
				`approval:${questionId}`,
				instructionApprovalRequired,
			);
		},
		/**
		 * Runs on the first active observation after the user answered the approval question.
		 * Returns true when it changed the task (asked a new question), so `t` is stale for the caller.
		 */
		resolve(db: Database, t: WorkTask, s: Supervisor): boolean {
			const p = s.pendingApproval;
			if (p?.resolution !== "pending") return false;
			const q = tasks().questionInTransaction(db, p.questionId);
			if (q?.state === "open") return false;
			if (!q || q.state !== "answered" || s.holdReason || s.stepId) {
				p.resolution = "expired";
				return false;
			}
			if (!isApproved(q.answer)) {
				p.resolution = "rejected";
				escalate(
					db,
					t,
					s,
					"監督AIの指示は却下されました。実装用CLIへの次の方針を指定してください。",
				);
				return true;
			}
			p.resolution = "approved";
			if (
				!stopped(s) ||
				semanticObservationDigest(s.observation) !== p.observationDigest
			)
				s.handledFingerprint = null;
			else apply(db, t, s, p.decision, true);
			return false;
		},
	};
}
