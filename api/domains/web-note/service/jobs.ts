import { z } from "zod";
import { toErrorCode } from "../../../infrastructure/error-code";
import type { WebNoteAttempt, WebNoteTurn } from "../contracts";
import { active, rowOf, save, stateOf } from "../repository";
import { WEB_NOTE_RESOURCE, type Context } from "./context";
import { current, end, finish, forget } from "./lifecycle";
import { noteResult, parseNote, today, type Note } from "./note";
import policy from "./policy.json";

/** The queue kind of a run. */
export const WEB_NOTE_JOB = "web-note.run";
const payload = z.strictObject({ id: z.uuid() });
type Payload = z.infer<typeof payload>;
type Prepared = { id: string; instructions: string; request: string };
type Done = Note & { searches: number };

/** A turn failure as a stable code; provider and process text never reaches a record. */
function turnCode(error: unknown): string {
	const coded = toErrorCode(error, "");
	if (coded.startsWith("web_note_")) return coded;
	if (
		error instanceof Error &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "EACCES")
	)
		return "web_note_codex_unavailable";
	const message = error instanceof Error ? error.message : "";
	if (/^Codex Exec exited with (code|signal)/.test(message))
		return /\b(401|403)\b|log ?in|unauthor|not signed in|sign in/i.test(message)
			? "web_note_codex_not_logged_in"
			: "web_note_codex_exit";
	return "web_note_turn_failed";
}

/** The queue handler of a run: one Codex turn, answered with a note, settled into the task. */
export function registerJobs(ctx: Context) {
	ctx.queue.registerHandler<Payload, Prepared, Done>({
		kind: WEB_NOTE_JOB,
		payloadVersions: [1],
		schema: payload,
		recovery: "replay_safe",
		resourceKey: WEB_NOTE_RESOURCE,
		prepareInTransaction(db, claim) {
			const row = rowOf(db, claim.payload.id);
			if (!row?.data_json || !active(row) || row.job_id !== claim.jobId)
				return { status: "stale", reason: "web_note_run_stale" };
			if (row.deadline <= ctx.now()) {
				row.job_id = null;
				end(ctx, db, row, "failed", "web_note_deadline_exceeded");
				return { status: "stale", reason: "web_note_deadline_exceeded" };
			}
			try {
				current(ctx, db, row.id);
			} catch {
				forget(ctx, db, row.id);
				return { status: "stale", reason: "web_note_source_invalid" };
			}
			const state = stateOf(row);
			row.state = "deciding";
			save(db, row, state, ctx.now());
			return {
				status: "ready",
				input: {
					id: row.id,
					instructions: state.instructions,
					request: state.request,
				},
			};
		},
		async execute(input, { signal }) {
			if (!ctx.turn) throw new Error("web_note_codex_unavailable");
			// No Codex call is made (and none recorded) for a setting that names an unusable resource.
			let model: string | null;
			try {
				model = ctx.model?.() ?? null;
			} catch (error) {
				throw new Error(turnCode(error));
			}
			const started = ctx.now();
			const subject = `web-note:${input.id}`;
			const attempt = (
				status: WebNoteAttempt["status"],
				reason: string | null,
				usage: WebNoteAttempt["usage"],
			) =>
				ctx.record?.({
					subject,
					model,
					started,
					ended: ctx.now(),
					status,
					reason,
					usage,
				});
			let turn: Awaited<ReturnType<WebNoteTurn>>;
			try {
				turn = await ctx.turn({
					model,
					reasoning: policy.reasoning as "low",
					webSearch: policy.webSearch as "live",
					prompt: `${input.instructions.replaceAll("{{today}}", today(started))}\n\n依頼:\n${input.request}`,
					signal,
				});
			} catch (error) {
				// The queue aborts for more than a cancel (deadline, lost lease, shutdown): the ledger names which.
				const reason =
					signal.reason instanceof Error ? signal.reason.message : "";
				const code = !signal.aborted
					? turnCode(error)
					: reason === "deadline_exceeded"
						? "web_note_deadline_exceeded"
						: reason === "cancelled" || reason === ""
							? "web_note_cancelled"
							: `web_note_${reason}`;
				await attempt("failed", code, null)?.catch(() => {});
				throw new Error(code);
			}
			if (Buffer.byteLength(turn.text) > policy.outputMaxBytes) {
				await attempt("failed", "web_note_output_limit", turn.usage)?.catch(
					() => {},
				);
				throw new Error("web_note_output_limit");
			}
			if (!turn.text.trim()) {
				await attempt("failed", "web_note_empty_output", turn.usage)?.catch(
					() => {},
				);
				throw new Error("web_note_empty_output");
			}
			await attempt("succeeded", null, turn.usage)?.catch(() => {});
			return { ...parseNote(turn.text), searches: turn.searches };
		},
		classify: () => "fail",
		settleInTransaction(db, claim, _input, outcome) {
			const row = rowOf(db, claim.payload.id);
			if (!row?.data_json || !active(row) || row.job_id !== claim.jobId)
				return "stale";
			row.job_id = null;
			try {
				current(ctx, db, row.id);
			} catch (error) {
				if (
					error instanceof Error &&
					error.message === "web_note_deadline_exceeded"
				) {
					end(ctx, db, row, "failed", error.message);
					return "applied";
				}
				forget(ctx, db, row.id);
				return "stale";
			}
			if (outcome.type === "success") {
				const { searches: _searches, ...note } = outcome.result;
				finish(ctx, db, row, "completed", noteResult(note, ctx.now()));
			} else if (outcome.type === "interrupted")
				end(ctx, db, row, "interrupted", outcome.errorCode);
			else
				end(
					ctx,
					db,
					row,
					"failed",
					outcome.type === "failed" || outcome.type === "retry"
						? outcome.errorCode
						: "web_note_deadline_exceeded",
				);
			return "applied";
		},
		cancelInTransaction() {
			/* The owner changes authority before it requests the queue's cancellation. */
		},
	});
}
