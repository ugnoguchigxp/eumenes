import type { Database } from "bun:sqlite";
import { getLogger } from "../../../infrastructure/logger";
import { executionControl, type TaskLifecyclePort } from "../../tool-runtime";
import type { HostState, SourcePort } from "../contracts";
import { active, rowOf } from "../repository";
import { ADAPTER, type Context, type WebNoteDeps } from "./context";
import { registerJobs, WEB_NOTE_JOB } from "./jobs";
import {
	current,
	end,
	forget,
	reconcile,
	viewInTransaction,
} from "./lifecycle";
import policy from "./policy.json";

export { WEB_NOTE_RESOURCE, type WebNoteDeps } from "./context";

const log = getLogger("web-note");

/**
 * Research notes by Codex's own web search: one Codex turn per request, answered with a note (title, summary,
 * Markdown body with its sources). The run is a queue job; the task lifecycle is what the dialogue and the agency
 * start, view, cancel and forget. A run that cannot end in a note ends failed with a reason, never as a made-up note.
 */
export function createWebNote(deps: WebNoteDeps) {
	const newId = deps.id ?? (() => crypto.randomUUID());
	let source: SourcePort | undefined;
	let closed = false;
	const ctx: Context = {
		...deps,
		now: deps.now ?? Date.now,
		abortJobs: new Set(),
		source() {
			if (!source) throw new Error("web_note_not_configured");
			return source;
		},
	};
	registerJobs(ctx);

	const task: TaskLifecyclePort = {
		startInTransaction(db, input) {
			if (closed || !source || !ctx.turn)
				throw new Error("web_note_unavailable");
			if (!input.toolchainRevisionId || !input.bindingRevisionId)
				throw new Error("web_note_unavailable");
			if (!source.validSourceInTransaction(db, input.source))
				throw new Error("web_note_source_invalid");
			const set = ctx.capabilities.toolchainSetInTransaction(
					db,
					input.toolchainRevisionId,
				),
				binding = set.binding?.document;
			if (
				set.binding?.revisionId !== input.bindingRevisionId ||
				binding?.execution !== "task" ||
				binding.adapterRef !== ADAPTER
			)
				throw new Error("web_note_binding_invalid");
			const request = input.request.trim();
			if (!request || request.length > policy.requestMaxChars)
				throw new Error("web_note_request_invalid");
			const id = newId(),
				at = ctx.now(),
				deadline = Math.min(
					at + binding.timeLimits.runMs,
					input.deadline ?? Number.POSITIVE_INFINITY,
				);
			const state: HostState = {
				source: input.source,
				request,
				toolchainRevisionId: input.toolchainRevisionId,
				bindingRevisionId: input.bindingRevisionId,
				instructions: [set.profile, ...set.skills].join("\n"),
				result: null,
			};
			const job = ctx.queue.enqueueInTransaction(db, {
				scope: "web-note",
				kind: WEB_NOTE_JOB,
				dedupeKey: id,
				subjectRef: id,
				concurrencyKey: `web-note:${id}`,
				lane:
					input.source.origin === "autonomous" ? "background" : "interactive",
				deadlineAtMs: deadline,
				payload: { id },
				maxAttempts: 1,
			});
			db.query(
				"INSERT INTO web_note_runs(id,conversation_id,state,revision,deadline,job_id,data_json,notice,created_at,updated_at) VALUES (?,?,'queued',0,?,?,?,'none',?,?)",
			).run(
				id,
				input.source.conversationId,
				deadline,
				job.job.id,
				JSON.stringify(state),
				at,
				at,
			);
			return viewInTransaction(db, id)!;
		},
		controlInTransaction(db, conversationId, raw) {
			const input = executionControl.parse(raw),
				row = current(ctx, db, input.workRef, true);
			if (row.conversation_id !== conversationId)
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
				current(ctx, db, id, true);
				return viewInTransaction(db, id);
			} catch {
				return null;
			}
		},
		cancelInTransaction(db, conversationId, id) {
			const row = rowOf(db, id);
			if (
				row?.data_json &&
				row.conversation_id === conversationId &&
				active(row)
			)
				end(ctx, db, row, "cancelled", "web_note_user_cancelled");
		},
		forgetInTransaction: (db, id) => forget(ctx, db, id),
	};

	function flush() {
		ctx.queue.flushCancellations([...ctx.abortJobs]);
		ctx.abortJobs.clear();
		ctx.queue.wake();
	}
	async function maintain() {
		if (closed || !source) return;
		await ctx.store.write((db: Database) => reconcile(ctx, db));
		flush();
	}
	return {
		task,
		configure(port: SourcePort) {
			source = port;
		},
		availableInTransaction: () =>
			!closed && source !== undefined && deps.turn !== undefined,
		sourceRunInTransaction(db: Database, id: string) {
			try {
				return rowSource(current(ctx, db, id, true).data_json);
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
			flush();
		},
	};
}
export type WebNoteService = ReturnType<typeof createWebNote>;
const rowSource = (json: string | null) =>
	(JSON.parse(json!) as HostState).source.runId;
