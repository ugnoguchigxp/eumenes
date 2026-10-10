import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { HandlerDefinition } from "../../queue";
import type { WorkTask } from "../../tasks";
import {
	observationSchema,
	type DiagnosticIntent,
	type ReadFocus,
	type Observation,
	type Supervisor,
} from "../contracts";
import * as repo from "../repository";
import { live } from "./policy";
import type { SupervisionContext } from "./context";
import type { createLifecycle } from "./lifecycle";

const schema = z.strictObject({
	id: z.string(),
	taskId: z.string(),
	generation: z.number().int().positive(),
	authorityEpoch: z.number().int().positive(),
	executionId: z.string(),
	code: z.string().max(100),
	deadline: z.number().int().positive(),
	focus: z
		.strictObject({
			ref: z.string().max(160),
			offset: z.number().int().nonnegative(),
		})
		.optional(),
});
/** Per code and per execution/generation/authority; consumed when the read is reserved. */
export const diagnosticLimits = { perCode: 2, total: 4, readMs: 5000 } as const;
/** These do not improve by looking again: one confirming read, then stop. */
const settled = new Set([
	"capture_incomplete",
	"turn_failed",
	"turn_cancelled",
	"turn_conflict",
	"coding_legacy_continue_unsupported",
	"evidence_incomplete",
]);
const open_ = (t: WorkTask) =>
	t.state === "active" || t.state === "reconciling";
/** Passing trouble: handled by the ordinary monitoring-failure policy, never by a diagnosis hold. */
export const transientCodes = new Set([
	"observation_unknown",
	"observation_stale",
	"read_timeout",
	"authority_stale",
	"execution_stale",
]);
const readFailure: Record<string, string> = {
	runner_evidence_digest_conflict: "digest_mismatch",
	coding_observation_stale: "observation_stale",
	supervision_read_timeout: "read_timeout",
};
export type ReadResult =
	| { ok: true; observation: Observation }
	| { ok: false; code: string };

/** The fixed code that names why a run cannot be confirmed, or null when nothing is wrong. */
export function diagnosticCode(s: Supervisor): string | null {
	if (s.observationIssue && !transientCodes.has(s.observationIssue.code))
		return s.observationIssue.code;
	const o = s.observation,
		d = o?.details;
	if (!o || !d) return null;
	if (
		d.limitations.includes("legacy_source_unknown") &&
		d.run.turnOutcome !== "completed"
	)
		return "coding_legacy_continue_unsupported";
	if (d.run.captureState === "incomplete") return "capture_incomplete";
	if (["failed", "cancelled", "conflict"].includes(d.run.turnOutcome))
		return `turn_${d.run.turnOutcome}`;
	if (d.run.turnOutcome === "unconfirmed" && o.childrenStopped)
		return "turn_unconfirmed";
	// A normal turn whose evidence cannot be used (non-zero exit, changed review snapshot, worker fault).
	if (
		d.run.turnOutcome === "completed" &&
		o.childrenStopped &&
		!o.evidenceComplete
	)
		return "evidence_incomplete";
	return null;
}
/**
 * Durable, bounded read intents. They are independent of mutation policy, the decision model,
 * the tokenizer and "workflow available": a stopped or held run can always be looked at again.
 */
export function createDiagnostics(
	ctx: SupervisionContext,
	deps: {
		lifecycle: ReturnType<typeof createLifecycle>;
		observe: (
			db: Database,
			taskId: string,
			o: Observation,
			source: "diagnostic",
		) => void;
	},
) {
	const scopeOf = (s: Supervisor, executionId: string) =>
		`${executionId}:${s.generation}:${s.authorityEpoch}`;
	/** Stops automatic diagnosis once the process is confirmed stopped; otherwise keeps watching. */
	function finalize(db: Database, t: WorkTask, s: Supervisor, code: string) {
		if (t.kind !== "coding") throw new Error("invalid_coding_task");
		const o = s.observation;
		if (!o || s.diagnostics?.blocked) return;
		if (!o.childrenStopped) {
			ctx.report(
				db,
				t,
				s,
				"monitoring_issue",
				"実行の確認を続けています。停止はまだ確認できていません。",
				`unstopped:${o.executionId}`,
				code,
			);
			return;
		}
		deps.lifecycle.invalidate(db, s);
		s.holdReason = code;
		s.diagnostics = {
			...(s.diagnostics ?? {
				scope: scopeOf(s, o.executionId),
				total: 0,
				codes: {},
				activeId: null,
			}),
			blocked: true,
		};
		const left = Math.max(0, t.grant.maxDecisions - s.decisionsUsed);
		// Not a "blocker": that kind means the user is asked a question, and none is asked here.
		ctx.report(
			db,
			t,
			s,
			"monitoring_issue",
			`実行の確認を打ち切りました(${code})。process停止は確認済みです。確認済み: turn=${o.details?.run.turnOutcome ?? "不明"}、検証=${s.checks ? "記録あり" : "未実施"}。未検証: 成果物の内容。権限は既存grantのまま、残り判断回数=${left}、修正回数=${Math.max(0, 2 - s.repairLoops)}。`,
			`blocked:${o.executionId}`,
			code,
		);
	}
	function request(
		db: Database,
		t: WorkTask,
		s: Supervisor,
		code: string,
		focus?: ReadFocus,
	) {
		const executionId = s.observation?.executionId;
		if (!executionId || !live(t, ctx.now()) || !open_(t)) return;
		const scope = scopeOf(s, executionId);
		if (s.diagnostics?.scope !== scope)
			s.diagnostics = {
				scope,
				total: 0,
				codes: {},
				activeId: null,
				...(s.diagnostics?.requestedFor
					? { requestedFor: s.diagnostics.requestedFor }
					: {}),
			};
		const budget = s.diagnostics;
		if (budget.blocked || budget.activeId) return;
		if (
			(budget.codes[code] ?? 0) >= diagnosticLimits.perCode ||
			// A model-requested extra look never uses the slots a real anomaly needs.
			(code !== "inspect_more" && budget.total >= diagnosticLimits.total)
		) {
			// A model-requested extra look is simply refused; a real anomaly ends the diagnosis.
			if (code !== "inspect_more") finalize(db, t, s, code);
			repo.put(db, s);
			return;
		}
		const intent: DiagnosticIntent = {
			id: crypto.randomUUID(),
			taskId: t.id,
			generation: t.executionGeneration,
			authorityEpoch: t.authorityEpoch,
			executionId,
			code,
			...(focus ? { focus } : {}),
			deadline: Math.min(
				ctx.now() + diagnosticLimits.readMs,
				Date.parse(t.grant.expiresAt),
				Date.parse(t.executionDeadlineAt!),
			),
		};
		ctx.queue.enqueueInTransaction(db, {
			scope: `supervision:${t.id}`,
			kind: "coding-supervision.inspect.v1",
			payload: intent,
			dedupeKey: intent.id,
			subjectRef: t.id,
			lane: "background",
			concurrencyKey: `supervision:${t.id}:inspect`,
			maxAttempts: 1,
			deadlineAtMs: intent.deadline,
		});
		// Reserved now; failure, timeout, crash and cancellation never give it back.
		if (code !== "inspect_more") budget.total++;
		budget.codes[code] = (budget.codes[code] ?? 0) + 1;
		budget.activeId = intent.id;
		repo.put(db, s);
	}
	function current(db: Database, i: DiagnosticIntent) {
		const t = ctx.tasks().getInTransaction(db, i.taskId),
			s = repo.get(db, i.taskId);
		return t &&
			s &&
			!ctx.state.closed &&
			live(t, ctx.now()) &&
			open_(t) &&
			t.executionGeneration === i.generation &&
			t.authorityEpoch === i.authorityEpoch &&
			s.observation?.executionId === i.executionId &&
			s.diagnostics?.activeId === i.id
			? { t, s }
			: null;
	}
	const handler: HandlerDefinition<
		DiagnosticIntent,
		DiagnosticIntent,
		ReadResult
	> = {
		kind: "coding-supervision.inspect.v1",
		payloadVersions: [1],
		schema,
		recovery: "interrupt",
		prepareInTransaction(db, c) {
			if (current(db, c.payload)) return { status: "ready", input: c.payload };
			// The queue cancels a stale job without settling it: free the slot here.
			const s = repo.get(db, c.payload.taskId);
			if (s?.diagnostics?.activeId === c.payload.id) {
				s.diagnostics.activeId = null;
				repo.put(db, s);
			}
			return { status: "stale", reason: "supervision_read_stale" };
		},
		async execute(i, c) {
			const signal = AbortSignal.any([
				c.signal,
				AbortSignal.timeout(Math.max(1, i.deadline - ctx.now())),
			]);
			const reader = ctx.observationReader ?? {
				inspect: ctx.workflow.observe.bind(ctx.workflow),
			};
			try {
				const observation = observationSchema.parse(
					await reader.inspect(i.taskId, signal, i.focus),
				);
				signal.throwIfAborted();
				return { ok: true, observation };
			} catch (error) {
				const m = error instanceof Error ? error.message : "";
				return {
					ok: false,
					code: signal.aborted
						? "read_timeout"
						: (readFailure[m] ?? "observation_unknown"),
				};
			}
		},
		settleInTransaction(db, c, _i, outcome) {
			const active = current(db, c.payload);
			if (!active) {
				// The task moved on while the read ran: free the slot, keep the spent budget.
				const s = repo.get(db, c.payload.taskId);
				if (s?.diagnostics?.activeId === c.payload.id) {
					s.diagnostics.activeId = null;
					repo.put(db, s);
				}
				return "stale";
			}
			const { t, s } = active;
			s.diagnostics!.activeId = null;
			if (
				outcome.type === "success" &&
				outcome.result.ok &&
				outcome.result.observation.executionId === c.payload.executionId
			) {
				// A model-requested look gets one fresh judgement of the new text (budgeted as a decision).
				if (c.payload.code === "inspect_more") s.handledFingerprint = null;
				repo.put(db, s);
				deps.observe(db, t.id, outcome.result.observation, "diagnostic");
				return "applied";
			}
			const code =
				outcome.type === "success" && !outcome.result.ok
					? outcome.result.code
					: "observation_unknown";
			s.observationIssue = {
				code,
				executionId: c.payload.executionId,
				lastCursor: s.observation?.eventSeq ?? null,
				at: ctx.now(),
			};
			repo.put(db, s);
			if (!transientCodes.has(code)) request(db, t, s, code);
			return "applied";
		},
		cancelInTransaction(db, job) {
			const active = current(db, job.payload);
			if (active) {
				active.s.diagnostics!.activeId = null;
				repo.put(db, active.s);
			}
		},
	};
	return {
		request,
		finalize,
		handler,
		/** Called with the result of a diagnostic read, after the observation was adopted. */
		afterDiagnosticRead(db: Database, t: WorkTask, s: Supervisor) {
			const code = diagnosticCode(s);
			if (code && settled.has(code)) {
				finalize(db, t, s, code);
				repo.put(db, s);
			} else if (code) request(db, t, s, code);
		},
	};
}
export type Diagnostics = ReturnType<typeof createDiagnostics>;
