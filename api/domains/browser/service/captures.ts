import { z } from "zod";
import type { Database } from "bun:sqlite";
import {
	ACTIVE_CAPTURE_LIMIT,
	activeCaptureStates,
	captureStart,
	type CaptureStart,
} from "../contracts";
import {
	activeCaptureCount,
	assertNoReplay,
	activeCaptures,
	captureByRequest,
	captureRow,
	captureView,
	dueCaptures,
	insertCapture,
	knownCaptureRefs,
	ownedCapture,
	ownedTask,
	patchCapture,
	tabRow,
} from "../repository";
import { checkScript } from "./script";
import type { ScriptBinding } from "../contracts/script";
import { runCapture } from "./capture-run";
import type { Ctx } from "./context";
import { connectedConnection } from "./connection";
import { finishCapture } from "./lifecycle";
import { assertActionable, openTab } from "./tabs";

const PAYLOAD = z.object({
	id: z.uuid(),
	step: z.number().int(),
	epoch: z.number().int(),
});
const safeCode = (code: string | null | undefined) =>
	code && /^[a-z][a-z0-9_]*$/.test(code) ? code : "capture_failed";
/** A managed ref is relative and stays inside the capture directory. */
const managedRef = (ref: string) =>
	!!ref &&
	!ref.startsWith("/") &&
	!ref.includes("\\") &&
	!ref.includes("\0") &&
	!ref.split("/").includes("..");

export type StartCaptureInput = CaptureStart & {
	scriptBinding?: ScriptBinding;
	owner: string;
	conversationId: string;
	origin: "conversation" | "screen";
	taskId?: string | null;
};

/**
 * Captures run as one queue job through `capturing → encoding → local_ready`. Measure first, refuse a side
 * over 2500 before shooting, check the PNG header again after, encode once and adopt a checked temp file.
 * The PNG lives in memory only; cancel and expiry move the epoch so a late stage cannot succeed.
 */
export function createCaptures(ctx: Ctx) {
	function enqueue(db: Database, id: string) {
		const r = captureRow(db, id)!;
		const step = r.step + 1;
		patchCapture(db, id, { step }, ctx.now());
		ctx.queue.enqueueInTransaction(db, {
			scope: "browser",
			kind: "browser.capture.run",
			dedupeKey: `${id}:${step}`,
			payload: { id, step, epoch: r.epoch },
			subjectRef: id,
			lane: "interactive",
			resourceKey: "browser.capture",
			concurrencyKey: `browser:capture:${id}`,
			maxAttempts: 1,
		});
	}

	ctx.queue.registerHandler<
		{ id: string; step: number; epoch: number },
		{ id: string; epoch: number },
		true
	>({
		kind: "browser.capture.run",
		payloadVersions: [1],
		schema: PAYLOAD,
		recovery: "replay_safe",
		resourceKey: "browser.capture",
		prepareInTransaction(db, claim) {
			const r = captureRow(db, claim.payload.id);
			if (
				!r ||
				r.step !== claim.payload.step ||
				r.epoch !== claim.payload.epoch ||
				!activeCaptureStates.includes(r.state)
			)
				return { status: "stale", reason: "browser_capture_state_changed" };
			if (ctx.now() >= r.deadline) {
				finishCapture(ctx, db, r.id, "expired", null);
				return { status: "stale", reason: "capture_expired" };
			}
			patchCapture(db, r.id, { state: "capturing" }, ctx.now());
			return { status: "ready", input: { id: r.id, epoch: r.epoch } };
		},
		async execute(input, { signal }) {
			await runCapture(ctx, input.id, input.epoch, signal);
			return true;
		},
		classify: () => "fail",
		settleInTransaction(db, claim, _input, outcome) {
			const r = captureRow(db, claim.payload.id);
			if (
				!r ||
				r.epoch !== claim.payload.epoch ||
				!activeCaptureStates.includes(r.state)
			)
				return "stale";
			if (outcome.type === "retry") return "applied";
			if (outcome.type === "success") return "applied";
			// Whatever stopped it, a capture past its deadline ended because time ran out.
			if (outcome.type === "expired" || ctx.now() >= r.deadline)
				finishCapture(ctx, db, r.id, "expired", null);
			else if (outcome.type === "interrupted")
				finishCapture(ctx, db, r.id, "failed", "capture_interrupted");
			else finishCapture(ctx, db, r.id, "failed", safeCode(outcome.errorCode));
			return "applied";
		},
		cancelInTransaction(db, job) {
			finishCapture(ctx, db, job.payload.id, "cancelled", null);
		},
	});

	function startInTransaction(db: Database, input: StartCaptureInput) {
		const { requestId, tabRef, range, elementRef, observationRef } = input;
		if (
			!captureStart.safeParse({
				requestId,
				tabRef,
				range,
				elementRef,
				observationRef,
			}).success
		)
			throw new Error("invalid_capture_request");
		const existing = captureByRequest(db, input.requestId);
		const taskId = input.taskId ?? null;
		if (existing) {
			if (
				existing.owner !== input.owner ||
				existing.tab_ref !== input.tabRef ||
				existing.range !== input.range ||
				existing.element_ref !== (input.elementRef ?? null) ||
				existing.task_id !== taskId
			)
				throw new Error("request_conflict");
			return captureView(existing);
		}
		const conn = connectedConnection(ctx, db);
		const tab = openTab(tabRow(db, input.tabRef));
		if (tab.connection_id !== conn.id) throw new Error("tab_lost");
		let deadline = ctx.now() + ctx.captureMs;
		if (taskId) {
			const t = ownedTask(db, taskId, input.owner);
			checkScript(t, input.scriptBinding);
			if (t.state !== "running") throw new Error("task_not_active");
			deadline = Math.min(deadline, t.deadline);
		}
		if (input.range === "element")
			assertActionable(
				db,
				tab,
				taskId,
				input.observationRef!,
				input.elementRef!,
			);
		assertNoReplay(db, input.owner);
		if (activeCaptureCount(db, input.owner) >= ACTIVE_CAPTURE_LIMIT)
			throw new Error("browser_capacity");
		const id = crypto.randomUUID();
		insertCapture(
			db,
			{
				id,
				owner: input.owner,
				conversationId: input.conversationId,
				origin: input.origin,
				requestId: input.requestId,
				taskId,
				tabRef: input.tabRef,
				range: input.range,
				elementRef: input.elementRef ?? null,
				observationRef: input.observationRef ?? null,
				deadline,
			},
			ctx.now(),
		);
		if (input.scriptBinding)
			db.query(
				"UPDATE browser_captures SET script_revision=?,script_step_id=? WHERE id=?",
			).run(input.scriptBinding.revision, input.scriptBinding.stepId, id);
		enqueue(db, id);
		return captureView(captureRow(db, id)!);
	}

	return {
		startInTransaction,
		cancelInTransaction(db: Database, owner: string, id: string) {
			ownedCapture(db, id, owner);
			finishCapture(ctx, db, id, "cancelled", null);
			return captureView(captureRow(db, id)!);
		},
		abortRunning: (id: string) =>
			ctx.inflight.get(`capture:${id}`)?.abort(new Error("capture_stale")),
		expireDue(db: Database) {
			const ended: string[] = [];
			for (const c of dueCaptures(db, ctx.now()))
				if (finishCapture(ctx, db, c.id, "expired", null)) ended.push(c.id);
			return ended;
		},
		status: (db: Database, owner: string, id: string) =>
			captureView(ownedCapture(db, id, owner)),
		async content(owner: string, id: string) {
			const r = ctx.store.read((db) => ownedCapture(db, id, owner));
			if (r.state !== "local_ready" || !r.webp_ref)
				throw new Error("browser_capture_not_ready");
			if (!managedRef(r.webp_ref))
				throw new Error("browser_capture_ref_invalid");
			return { bytes: await ctx.files.read(r.webp_ref), mime: "image/webp" };
		},
		/**
		 * Files no row points at, left by a crash: temp files and adopted images. Only when nothing is
		 * mid-capture, judged again after the files were listed.
		 */
		async removeOrphans() {
			const idle = () =>
				ctx.store.read((db) => activeCaptures(db).length === 0);
			if (!idle()) return;
			const listed = [
				...(await ctx.files.listTemp()),
				...(await ctx.files.listAdopted()),
			];
			const known = ctx.store.read(knownCaptureRefs);
			if (!idle()) return;
			for (const ref of listed)
				if (!known.has(ref)) await ctx.files.remove(ref).catch(() => undefined);
		},
	};
}
export type Captures = ReturnType<typeof createCaptures>;
