import type { Database } from "bun:sqlite";
import { getLogger } from "../../../infrastructure/logger";
import { CAPTURE_MAX_SIDE, activeCaptureStates } from "../contracts";
import {
	captureRow,
	clearLeases,
	openTabs,
	patchCapture,
	tabRow,
	taskRow,
	type CaptureRow,
} from "../repository";
import { checkScript } from "./script";
import { connectedConnection } from "./connection";
import { codeOf, type Ctx } from "./context";
import { finishCapture, readyNotice } from "./lifecycle";
import {
	acquireLease,
	assertActionable,
	keepLease,
	matchTabs,
	openTab,
	selectMatched,
	type Holder,
} from "./tabs";

const log = getLogger("browser");
const tooBig = (s: { width: number; height: number }) =>
	s.width > CAPTURE_MAX_SIDE || s.height > CAPTURE_MAX_SIDE;
const empty = (s: { width: number; height: number }) =>
	!(s.width >= 1 && s.height >= 1);

/** A late stage still belongs to an active task and the authorized connection. */
function checkCaptureContext(ctx: Ctx, db: Database, row: CaptureRow) {
	const conn = connectedConnection(ctx, db);
	if (tabRow(db, row.tab_ref)?.connection_id !== conn.id)
		throw new Error("tab_lost");
	const task = row.task_id ? taskRow(db, row.task_id) : null;
	if (
		row.task_id &&
		(!task || task.state !== "running" || ctx.now() >= task.deadline)
	)
		throw new Error("task_not_active");
	if (task)
		checkScript(
			task,
			row.script_revision && row.script_step_id
				? { revision: row.script_revision, stepId: row.script_step_id }
				: undefined,
		);
	return { conn, task };
}

/** Moves a live capture forward; a cancelled, expired or replaced one refuses with `capture_stale`. */
export function advanceCapture(
	ctx: Ctx,
	id: string,
	epoch: number,
	change: Parameters<typeof patchCapture>[2],
) {
	return ctx.store.write((db) => {
		const r = captureRow(db, id);
		if (!r || r.epoch !== epoch || !activeCaptureStates.includes(r.state))
			throw new Error("capture_stale");
		if (ctx.now() >= r.deadline) {
			finishCapture(ctx, db, id, "expired", null);
			throw new Error("capture_stale");
		}
		checkCaptureContext(ctx, db, r);
		return patchCapture(db, id, change, ctx.now());
	});
}

/**
 * The capture pipeline of one queue job: lease the tab, measure, refuse a side over 2500, shoot, check the PNG
 * header again, encode once and adopt a checked temp file. The page the tab shows is checked by `selectMatched`
 * before anything is measured; a blocked tab never reaches the screenshot.
 */
export async function runCapture(
	ctx: Ctx,
	id: string,
	epoch: number,
	signal: AbortSignal,
) {
	const advance = (change: Parameters<typeof patchCapture>[2]) =>
		advanceCapture(ctx, id, epoch, change);
	const controller = new AbortController();
	ctx.inflight.set(`capture:${id}`, controller);
	const link = AbortSignal.any([signal, controller.signal]);
	let tempRef: string | null = null;
	let finalRef: string | null = null;
	let stop = () => {};
	let holder: Holder | null = null;
	try {
		const lease = await ctx.store.write((db) => {
			const r = captureRow(db, id);
			if (!r || r.epoch !== epoch) throw new Error("capture_stale");
			const { conn, task } = checkCaptureContext(ctx, db, r);
			holder = task
				? { id: task.id, deadline: Math.min(task.deadline, r.deadline) }
				: { id: `capture:${id}`, deadline: r.deadline };
			const leased = acquireLease(ctx, db, r.tab_ref, holder);
			if (leased.tab.connection_id !== conn.id) throw new Error("tab_lost");
			return { row: r, conn: conn.id, ...leased };
		});
		stop = keepLease(ctx, lease.tab.tab_ref, holder!, lease.epoch, controller);
		const { row } = lease;
		const shot = await ctx.serialOf(lease.conn).run(async () => {
			await selectMatched(ctx, lease.conn, lease.tab);
			const before = ctx.store.read((db) => {
				const current = captureRow(db, id);
				if (
					!current ||
					current.epoch !== epoch ||
					!activeCaptureStates.includes(current.state) ||
					ctx.now() >= current.deadline
				)
					throw new Error("capture_stale");
				checkCaptureContext(ctx, db, current);
				const t = openTab(tabRow(db, row.tab_ref));
				if (row.range === "element")
					assertActionable(
						db,
						t,
						row.task_id,
						row.observation_ref!,
						row.element_ref!,
					);
				return t.generation;
			});
			const planned = await ctx.driver.measure(
				row.range,
				row.element_ref ?? undefined,
			);
			if (empty(planned)) throw new Error("capture_empty");
			if (tooBig(planned)) throw new Error("capture_dimensions_exceeded");
			const png = await ctx.driver.screenshot(
				row.range,
				row.element_ref ?? undefined,
				link,
			);
			const size = ctx.encoder.pngSize(png);
			if (empty(size)) throw new Error("capture_empty");
			if (tooBig(size)) throw new Error("capture_dimensions_exceeded");
			// The page must be the one that was measured: same tab, same URL, same generation.
			const after = await ctx.driver.listTabs();
			const same = ctx.store.read((db) =>
				matchTabs(openTabs(db, lease.conn), after).has(row.tab_ref),
			);
			const generation = ctx.store.read((db) => {
				const t = tabRow(db, row.tab_ref);
				return t?.status === "open" ? t.generation : -1;
			});
			if (!same || generation !== before)
				throw new Error("capture_tab_changed");
			return { png, size, planned };
		}, link);
		await advance({
			state: "encoding",
			planned_width: Math.ceil(shot.planned.width),
			planned_height: Math.ceil(shot.planned.height),
			png_width: shot.size.width,
			png_height: shot.size.height,
			png_bytes: shot.png.length,
		});
		const webp = await ctx.encoder.encodeWebp(shot.png, link);
		tempRef = await ctx.files.writeTemp(id, webp.bytes);
		await advance({ temp_ref: tempRef });
		const seen = await ctx.encoder.inspectWebp(await ctx.files.read(tempRef));
		if (
			!seen.lossy ||
			seen.width !== shot.size.width ||
			seen.height !== shot.size.height ||
			seen.sha256 !== webp.sha256
		)
			throw new Error("capture_encoding_invalid");
		finalRef = await ctx.files.adopt(tempRef, id);
		tempRef = null;
		const adopted = finalRef;
		const saved = await ctx.store.write((db) => {
			const r = captureRow(db, id);
			if (
				!r ||
				r.epoch !== epoch ||
				r.state !== "encoding" ||
				ctx.now() >= r.deadline
			)
				return false;
			checkCaptureContext(ctx, db, r);
			const done = patchCapture(
				db,
				id,
				{
					state: "local_ready",
					webp_ref: adopted,
					webp_sha256: webp.sha256,
					webp_bytes: webp.bytes.length,
					reduction_percent:
						Math.round((1 - webp.bytes.length / shot.png.length) * 10_000) /
						100,
					captured_at: ctx.now(),
					temp_ref: null,
				},
				ctx.now(),
			);
			if (!r.task_id) clearLeases(db, `capture:${id}`, ctx.now());
			readyNotice(ctx, db, done);
			return true;
		});
		if (!saved) throw new Error("capture_stale");
		finalRef = null;
		log.info("browser.capture_ready", {
			subjectId: id,
			bytes: webp.bytes.length,
		});
	} catch (e) {
		if (tempRef) await ctx.files.remove(tempRef).catch(() => undefined);
		if (finalRef) await ctx.files.remove(finalRef).catch(() => undefined);
		const code = codeOf(e, "capture_failed");
		if (code !== "capture_stale")
			log.warn("browser.capture_failed", { subjectId: id, reason: code });
		throw new Error(code);
	} finally {
		stop();
		ctx.inflight.delete(`capture:${id}`);
		if (holder && (holder as Holder).id.startsWith("capture:"))
			await ctx.store.write((db) =>
				clearLeases(db, `capture:${id}`, ctx.now()),
			);
	}
}
