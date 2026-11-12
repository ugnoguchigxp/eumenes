import type { Database } from "bun:sqlite";
import {
	hash,
	scheduleReadTarget,
	type ScheduleReadTarget,
} from "../../capabilities";
import type { ConversationEvent } from "../../continuity";
import { z } from "zod";
import { diagnosticRef } from "../contracts/diagnostics";
import { runViewingSchema } from "../contracts/specialist";
import { byId, runViewing } from "../repository";
import type { DialogueDeps } from "./context";

export const REPAIR_TOOLCHAIN = "claude-code.repair";
const savedEvidence = z.object({
	action: z.literal("read"),
	tool: z.literal("read_runs"),
	diagnostic: z.strictObject({
		runId: z.uuid(),
		target: scheduleReadTarget,
		digest: z.string().length(64),
		messageDigests: z.array(z.string().length(64)),
	}),
});

function blockedOf(deps: DialogueDeps, db: Database, conversationId: string) {
	return new Set(
		deps.memory?.blockedMessageIdsOfConversationInTransaction(
			db,
			conversationId,
		) ?? [],
	);
}

export function messageDigests(
	deps: DialogueDeps,
	db: Database,
	conversationId: string,
	ids: readonly string[],
) {
	const blocked = blockedOf(deps, db, conversationId);
	const messages = ids.map((id) =>
		blocked.has(id)
			? null
			: deps.conversation.messageInTransaction(db, id)?.message,
	);
	return messages.every((message) => message?.conversationId === conversationId)
		? messages.map((message) => hash(message!.text))
		: null;
}

/** The same bounded projection is used for the answer, the evidence digest and the approved handover. */
export function readDiagnostic(
	deps: DialogueDeps,
	db: Database,
	conversationId: string,
	runId: string,
	target: ScheduleReadTarget,
) {
	if (!deps.diagnostics) return null;
	const blocked = blockedOf(deps, db, conversationId);
	const projection = deps.diagnostics.readInTransaction(
		db,
		{
			conversationId,
			viewing: runViewingSchema.safeParse(runViewing(db, runId)).data ?? null,
			registrationVisible(requestId) {
				const origin = byId(db, requestId);
				return (
					!origin ||
					(origin.conversationId === conversationId &&
						!blocked.has(origin.inputMessageId) &&
						!!deps.conversation.messageInTransaction(db, origin.inputMessageId))
				);
			},
			run(id) {
				const run = byId(db, id);
				return run?.conversationId === conversationId &&
					!blocked.has(run.inputMessageId)
					? run
					: null;
			},
			answerSaved(run) {
				return (
					!!run.answerMessageId &&
					!blocked.has(run.answerMessageId) &&
					!!deps.conversation.messageInTransaction(db, run.answerMessageId)
				);
			},
		},
		target,
	);
	const bounded = { ...projection, items: [] as typeof projection.items };
	for (const item of projection.items) {
		bounded.items.push(item);
		if (JSON.stringify(bounded).length <= 2700) continue;
		bounded.items.pop();
		bounded.coverage = "partial";
		bounded.scope = { ...bounded.scope, output: "limited" };
		break;
	}
	return bounded;
}

function fromEvent(event: ConversationEvent | null) {
	if (
		!event ||
		event.forgotten ||
		event.by !== "agent" ||
		event.type !== "acted" ||
		!event.text
	)
		return null;
	const parsed = savedEvidence.safeParse(JSON.parse(event.text));
	return parsed.success ? parsed.data.diagnostic : null;
}

/** Resolves only host-issued evidence in this conversation and rejects changed sources or results. */
export function verifiedDiagnostic(
	deps: DialogueDeps,
	db: Database,
	conversationId: string,
	ref: string,
	currentRunId?: string,
	refresh = false,
) {
	if (!diagnosticRef.safeParse(ref).success) return null;
	try {
		const event = deps.continuity.events.eventInTransaction(
			db,
			conversationId,
			Number(ref.slice(1)),
		);
		const evidence = fromEvent(event);
		if (!evidence || !event) return null;
		const run = byId(db, evidence.runId);
		if (
			!run ||
			run.conversationId !== conversationId ||
			(run.status !== "completed" && run.id !== currentRunId)
		)
			return null;
		const digests = messageDigests(deps, db, conversationId, event.messageIds);
		if (!digests || hash(digests) !== hash(evidence.messageDigests))
			return null;
		const result = readDiagnostic(
			deps,
			db,
			conversationId,
			run.id,
			evidence.target,
		);
		return result && (refresh || hash(result) === evidence.digest)
			? {
					ref,
					observedAt: refresh ? deps.clock() : event.at,
					sourceRunId: run.id,
					target: evidence.target,
					...result,
				}
			: null;
	} catch {
		return null;
	}
}

function recentReads(deps: DialogueDeps, db: Database, conversationId: string) {
	if (!deps.diagnostics) return [];
	const events = deps.continuity.events;
	return events
		.loggedAfterInTransaction(
			db,
			conversationId,
			Math.max(0, events.latestSeqInTransaction(db, conversationId) - 40),
		)
		.filter((event) => fromEvent(event) !== null)
		.slice(-3);
}

export function recentDiagnostics(
	deps: DialogueDeps,
	db: Database,
	conversationId: string,
) {
	return recentReads(deps, db, conversationId).flatMap((event) => {
		const evidence = verifiedDiagnostic(deps, db, conversationId, event.id);
		return evidence
			? [
					{
						ref: event.id,
						line: `- 予約の診断 ${event.id}（${event.at}${evidence.target.id ? `、予約 ${evidence.target.id}` : ""}）`,
					},
				]
			: [];
	});
}

export function backgroundDiagnostic(
	deps: DialogueDeps,
	db: Database,
	conversationId: string,
) {
	const event = recentReads(deps, db, conversationId).at(-1);
	const result = event
		? verifiedDiagnostic(deps, db, conversationId, event.id, undefined, true)
		: null;
	if (!result) return null;
	const { observedAt, ...facts } = result;
	return {
		text: JSON.stringify({ observedAt, ...facts }),
		digest: hash(facts),
	};
}

export function diagnosticRepairPrompt(
	evidence: NonNullable<ReturnType<typeof verifiedDiagnostic>>,
) {
	return [
		"Eumenes の予約について、下の観測記録から実際に起きたことを調べてください。",
		"関連コードと記録を照合し、隔離した条件で再現し、原因・改善案・完了条件を報告してください。今回の作業範囲は分析までです。製品の編集・サーバーの操作・commit・push は行わないでください。",
		"予約の登録、実行、成果の保存を区別してください。記録が欠ける場合は確認範囲と未確認の点を示してください。失敗・中断した会話実行が記録にある場合は、既存の CLI の error-report を参照できます。",
		`Eumenes が確認した記録\n${JSON.stringify(evidence)}`,
	].join("\n\n");
}
