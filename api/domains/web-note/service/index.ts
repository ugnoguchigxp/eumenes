import type { Database } from "bun:sqlite";
import { getLogger } from "../../../infrastructure/logger";
import { hash } from "../../capabilities";
import {
	executionControl,
	isGoalExecutionSource,
	isStandardExecutionSource,
	type GoalExecutionSource,
	isSupervisedExecutionSource,
	type TaskLifecyclePort,
} from "../../tool-runtime";
import type { GoalWebNoteOwner, HostState, SourcePort } from "../contracts";
import { active, rowOf, stateOf } from "../repository";
import {
	ADAPTER,
	INSPECT_SOURCE_ADAPTER,
	type Context,
	type WebNoteDeps,
} from "./context";
import { createGoalWebNotePort } from "./goal";
import { createSupervisedWebNotePort } from "./supervised";
import { registerJobs, WEB_NOTE_JOB } from "./jobs";
import {
	current,
	end,
	forget,
	reconcile,
	viewInTransaction,
} from "./lifecycle";
import policy from "./policy.json";

export {
	INSPECT_SOURCE_ADAPTER,
	WEB_NOTE_RESOURCE,
	type WebNoteDeps,
} from "./context";

const log = getLogger("web-note");

/**
 * Research notes by Codex's own web search: one Codex turn per request, answered with a note (title, summary,
 * Markdown body with its sources). The run is a queue job; the task lifecycle is what the dialogue and the agency
 * start, view, cancel and forget. A run that cannot end in a note ends failed with a reason, never as a made-up note.
 */
export function createWebNote(deps: WebNoteDeps) {
	const newId = deps.id ?? (() => crypto.randomUUID());
	let source: SourcePort | undefined;
	let goal: GoalWebNoteOwner | undefined;
	let closed = false;
	const ctx: Context = {
		...deps,
		now: deps.now ?? Date.now,
		abortJobs: new Set(),
		goal: () => goal,
		source() {
			if (!source) throw new Error("web_note_not_configured");
			return source;
		},
	};
	registerJobs(ctx);

	type Start = Parameters<TaskLifecyclePort["startInTransaction"]>[1];
	function startInTransaction(
		db: Database,
		input: Omit<Start, "source"> & {
			source: Start["source"] | GoalExecutionSource;
		},
		operationId?: string,
	) {
		if (closed || !source) throw new Error("web_note_unavailable");
		if (!input.toolchainRevisionId || !input.bindingRevisionId)
			throw new Error("web_note_unavailable");
		let grantDeadline = Infinity;
		if (input.source.origin === "goal") {
			if (
				!isGoalExecutionSource(input.source) ||
				hash([input.source.request, input.source.expectedObservation]) !==
					input.source.digest ||
				input.source.request !== input.request ||
				input.source.runId !== operationId ||
				input.source.toolchainRevisionId !== input.toolchainRevisionId ||
				input.source.bindingRevisionId !== input.bindingRevisionId ||
				!goal?.authorityInTransaction(db, input.source)
			)
				throw new Error("web_note_source_invalid");
		} else if (operationId !== undefined) {
			if (!operationId || !isSupervisedExecutionSource(input.source))
				throw new Error("web_note_source_invalid");
			const grant = source.supervised?.authorizeInTransaction(db, {
				source: input.source,
				request: input.request,
				action: "start",
				operationId,
				toolchainRevisionId: input.toolchainRevisionId,
				bindingRevisionId: input.bindingRevisionId,
			});
			if (!grant || grant.deadline <= ctx.now())
				throw new Error("web_note_source_invalid");
			grantDeadline = grant.deadline;
		} else if (
			!isStandardExecutionSource(input.source) ||
			!source.validSourceInTransaction(db, input.source)
		) {
			throw new Error("web_note_source_invalid");
		}
		const set = ctx.capabilities.toolchainSetInTransaction(
				db,
				input.toolchainRevisionId,
			),
			binding = set.binding?.document;
		const inspection = binding?.adapterRef === INSPECT_SOURCE_ADAPTER;
		if (
			set.binding?.revisionId !== input.bindingRevisionId ||
			binding?.execution !== "task" ||
			(!inspection && binding.adapterRef !== ADAPTER)
		)
			throw new Error("web_note_binding_invalid");
		if (inspection) {
			if (input.source.origin === "goal")
				throw new Error("web_note_binding_invalid");
			if (!ctx.inspectSource) throw new Error("inspect_source_unavailable");
			if (
				operationId === undefined &&
				(input.source.origin ||
					!input.source.messageId ||
					input.source.specialistSessionId !== undefined)
			)
				throw new Error("inspect_source_conversation_required");
		} else if (!ctx.turn) throw new Error("web_note_unavailable");
		const request = input.request.trim();
		if (!request || request.length > policy.requestMaxChars)
			throw new Error("web_note_request_invalid");
		const startDigest = operationId === undefined ? undefined : hash(input);
		if (operationId !== undefined) {
			const prior = rowOf(db, operationId);
			if (prior) {
				if (!prior.data_json || stateOf(prior).startDigest !== startDigest)
					throw new Error("web_note_start_conflict");
				return operationId;
			}
		}
		const id = operationId ?? newId(),
			at = ctx.now(),
			deadline = Math.min(
				at + binding.timeLimits.runMs,
				input.deadline ?? Number.POSITIVE_INFINITY,
				grantDeadline,
			);
		if (operationId !== undefined && deadline <= at)
			throw new Error("web_note_deadline_exceeded");
		const state: HostState = {
			source: input.source,
			...(startDigest ? { startDigest } : {}),
			request,
			toolchainRevisionId: input.toolchainRevisionId,
			bindingRevisionId: input.bindingRevisionId,
			instructions: [set.profile, ...set.skills].join("\n"),
			...(inspection ? { inspection: {} } : {}),
			result: null,
		};
		const job = ctx.queue.enqueueInTransaction(db, {
			scope: "web-note",
			kind: WEB_NOTE_JOB,
			dedupeKey: id,
			subjectRef: id,
			concurrencyKey: `web-note:${id}`,
			lane:
				input.source.origin === "goal" ||
				input.source.origin === "autonomous" ||
				input.source.origin === "supervised"
					? "background"
					: "interactive",
			deadlineAtMs: deadline,
			payload: { id },
			maxAttempts: 1,
		});
		db.query(
			"INSERT INTO web_note_runs(id,owner_key,owner_kind,state,revision,deadline,job_id,data_json,notice,created_at,updated_at) VALUES (?,?,?,'queued',0,?,?,?,'none',?,?)",
		).run(
			id,
			input.source.origin === "goal"
				? input.source.goalId
				: input.source.conversationId,
			input.source.origin === "goal" ? "goal" : "conversation",
			deadline,
			job.job.id,
			JSON.stringify(state),
			at,
			at,
		);
		return id;
	}
	const task: TaskLifecyclePort = {
		startInTransaction: (db, input) =>
			viewInTransaction(db, startInTransaction(db, input))!,
		controlInTransaction(db, conversationId, raw) {
			const input = executionControl.parse(raw),
				row = current(ctx, db, input.workRef, true);
			if (!isStandardExecutionSource(stateOf(row).source))
				throw new Error("web_note_source_invalid");
			if (row.owner_kind !== "conversation" || row.owner_key !== conversationId)
				throw new Error("web_note_conversation_mismatch");
			if (input.action === "status") return viewInTransaction(db, row.id)!;
			if (input.expectedRevision !== row.revision)
				throw new Error("execution_revision_conflict");
			if (!active(row)) throw new Error("execution_terminal");
			if (input.action !== "cancel")
				throw new Error("web_note_control_unsupported");
			end(ctx, db, row, "cancelled", "web_note_user_cancelled");
			return viewInTransaction(db, row.id)!;
		},
		viewInTransaction(db, id) {
			try {
				const row = current(ctx, db, id, true);
				if (
					row.owner_kind !== "conversation" ||
					!isStandardExecutionSource(stateOf(row).source)
				)
					return null;
				return viewInTransaction(db, id);
			} catch {
				return null;
			}
		},
		cancelInTransaction(db, conversationId, id) {
			const row = rowOf(db, id);
			if (
				row?.owner_kind === "conversation" &&
				row.data_json &&
				isStandardExecutionSource(stateOf(row).source) &&
				row.owner_key === conversationId &&
				active(row)
			)
				end(ctx, db, row, "cancelled", "web_note_user_cancelled");
		},
		forgetInTransaction(db, id) {
			const row = rowOf(db, id);
			if (
				row?.owner_kind === "conversation" &&
				row.data_json &&
				isStandardExecutionSource(stateOf(row).source)
			)
				forget(ctx, db, id);
		},
	};

	function flush() {
		ctx.queue.flushCancellations([...ctx.abortJobs]);
		ctx.abortJobs.clear();
	}
	// Task controls and erasure run inside the caller's transaction. Abort only after the queue record commits.
	const stopCommits = ctx.store.onCommit(() => {
		if (ctx.abortJobs.size) flush();
	});
	async function maintain() {
		if (closed || !source) return;
		await ctx.store.write((db: Database) => reconcile(ctx, db));
		flush();
	}

	return {
		task,
		supervised: createSupervisedWebNotePort(
			ctx,
			() => source,
			startInTransaction,
		),

		goal: createGoalWebNotePort(ctx, (db, origin) =>
			startInTransaction(
				db,
				{
					source: origin,
					request: origin.request,
					references: [],
					toolchainRevisionId: origin.toolchainRevisionId,
					bindingRevisionId: origin.bindingRevisionId,
				},
				origin.runId,
			),
		),
		configureGoal(owner: GoalWebNoteOwner) {
			goal = owner;
		},
		configure(port: SourcePort) {
			source = port;
		},
		availableInTransaction: () =>
			!closed && source !== undefined && deps.turn !== undefined,
		inspectionAvailableInTransaction: () =>
			!closed && source !== undefined && deps.inspectSource !== undefined,
		sourceRunInTransaction(db: Database, id: string) {
			try {
				const row = current(ctx, db, id, true);
				return row.owner_kind === "conversation"
					? rowSource(row.data_json)
					: null;
			} catch {
				return null;
			}
		},
		flush,
		recover: () =>
			maintain().catch((error) =>
				log.warn(
					"web_note.maintenance_failed",
					{ reason: "maintenance_failed" },
					error,
				),
			),
		close() {
			closed = true;
			stopCommits();
			flush();
		},
	};
}
export type WebNoteService = ReturnType<typeof createWebNote>;
const rowSource = (json: string | null) =>
	(JSON.parse(json!) as HostState).source.runId;
