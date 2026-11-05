import type { Database } from "bun:sqlite";
import { createRun, transitionRun, listRuns } from "eumenes-interact/sqlite";
import {
	interactStart,
	interactAnswer,
	type InteractAnswer,
} from "../contracts/interact";
import { interactByRequest, interactMeta } from "../repository/interact";
import { approveInto } from "../repository/approvals";
import { ACTIVE_TASK_LIMIT } from "../contracts";
import { interactHash, interactIso } from "./interact-authority";
import { seedInteractSites } from "./interact-knowledge";
import type { InteractState } from "./interact-state";
import {
	INTERACT_EXPIRY_JOB as EXPIRY,
	type registerInteractQueue,
} from "./interact-queue";
const RETENTION = 30 * 86400000;
export function interactCommands(
	state: InteractState,
	enqueue: ReturnType<typeof registerInteractQueue>,
) {
	const { deps, queue, now, memory, authority, view } = state;
	return {
		startInTransaction(
			db: Database,
			owner: string,
			requestId: string,
			input: unknown,
			context: {
				source?: unknown;
				executionId?: string;
				deadline?: number;
			} = {},
		) {
			const args = interactStart.parse(input);
			if (
				context.source !== undefined &&
				!deps.validSource?.(db, context.source)
			)
				throw new Error("execution_source_invalid");
			const digest = interactHash({ args, source: context.source ?? null });
			const old = interactByRequest(db, owner, args.conversationId, requestId);
			if (old) {
				if (old.input_digest !== digest) throw new Error("request_conflict");
				return view(db, owner, args.conversationId, old.run_id);
			}
			const active = listRuns(db, owner, {
				statuses: ["queued", "running", "needs_input"],
				limit: ACTIVE_TASK_LIMIT,
			});
			if (active.length >= ACTIVE_TASK_LIMIT)
				throw new Error("browser_capacity");
			const id = crypto.randomUUID();
			if (deps.knowledgeSeed)
				seedInteractSites(db, owner, deps.knowledgeSeed, interactIso(now()));
			const deadline = Math.min(now() + 600000, context.deadline ?? Infinity);
			if (deadline <= now()) throw new Error("browser_interact_expired");
			createRun(db, owner, {
				runId: id,
				skillRef: deps.skill.ref,
				skillDigest: deps.skill.digest,
				catalogRef: "catalog:browser.interact@1",
				catalogDigest: `sha256:${interactHash({ contract: 2, parts: true })}`,
				platform: "playwright-mcp",
				coreFormatVersion: 1,
				policy: { maxModelCalls: args.maxModelCalls, retries: { default: 1 } },
				deadlineAt: interactIso(deadline),
				nowIso: interactIso(now()),
			});
			db.query(
				"INSERT INTO browser_interact_runs(run_id,owner,conversation_id,request_id,input_digest,execution_id,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)",
			).run(
				id,
				owner,
				args.conversationId,
				requestId,
				digest,
				context.executionId ?? null,
				now(),
				now() + RETENTION,
			);
			enqueue(db, interactMeta(db, id)!);
			queue.enqueueInTransaction(db, {
				scope: `browser-interact:${owner}`,
				kind: EXPIRY,
				payload: { runId: id, generation: 0 },
				dedupeKey: id,
				subjectRef: id,
				lane: "background",
				availableAtMs: deadline,
				maxAttempts: 1,
			});
			memory.set(id, {
				request: args.request,
				brief: args.brief,
				startUrl: args.startUrl,
				source: context.source,
				core: null,
				results: new Map(),
				controller: new AbortController(),
			});
			return view(db, owner, args.conversationId, id);
		},
		answerInTransaction(
			db: Database,
			owner: string,
			raw: unknown,
			source?: unknown,
		) {
			const args: InteractAnswer = interactAnswer.parse(raw);
			const { meta, run } = authority.owned(
				db,
				owner,
				args.conversationId,
				args.runId,
			);
			if (
				run.status !== "needs_input" ||
				meta.question_id !== args.questionId ||
				meta.generation !== args.generation ||
				meta.revision !== args.expectedRevision ||
				meta.question_deadline! <= now()
			)
				throw new Error("browser_interact_answer_stale");
			const mem = memory.get(args.runId);
			if (!mem) throw new Error("browser_interact_context_lost");
			if (meta.execution_id && source === undefined)
				throw new Error("browser_interact_parent_answer_required");
			const parentSource = source as
				{ kind?: string; execution?: { executionId?: string } } | undefined;
			if (
				meta.execution_id &&
				parentSource?.kind === "execution" &&
				parentSource.execution?.executionId !== meta.execution_id
			)
				throw new Error("browser_interact_parent_answer_required");
			if (source !== undefined) {
				if (!deps.validSource?.(db, source))
					throw new Error("execution_source_invalid");
				mem.source = source;
			}
			if (
				meta.question_kind === "approval" ||
				meta.question_kind === "capture"
			) {
				if (typeof args.approved !== "boolean" || args.text !== undefined)
					throw new Error("browser_interact_answer_invalid");
				if (!args.approved) {
					authority.end(db, args.runId, "failed", "approval_denied");
					return view(db, owner, args.conversationId, args.runId);
				}
				if (meta.question_kind === "capture") {
					const snapshot = mem.bridge?.snapshotDigest();
					if (!snapshot || !mem.pendingPart)
						throw new Error("browser_interact_answer_stale");
					mem.captureApproval = {
						partDigest: interactHash(mem.pendingPart),
						snapshot,
						generation: meta.generation + 1,
					};
				} else {
					if (!meta.approval_id)
						throw new Error("browser_interact_answer_stale");
					approveInto(db, meta.approval_id, args.runId, null, now());
				}
			} else {
				if (!args.text || args.approved !== undefined)
					throw new Error("browser_interact_answer_invalid");
				mem.request += `\n認証済みの回答:\n${args.text}`;
				mem.core = null;
				mem.parts = undefined;
			}
			transitionRun(db, owner, args.runId, "running", {
				nowIso: interactIso(now()),
			});
			db.query(
				"UPDATE browser_interact_runs SET generation=generation+1,revision=revision+1,question_id=NULL,question_kind=NULL,question_deadline=NULL WHERE run_id=?",
			).run(args.runId);
			mem.question = undefined;
			enqueue(db, interactMeta(db, args.runId)!);
			return view(db, owner, args.conversationId, args.runId);
		},
	};
}
