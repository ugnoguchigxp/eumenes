import { z } from "zod";
import { clockCandidates, closestWithin } from "./clock";
import type {
	CheckStatus,
	Criteria,
	FailureClass,
	HostSnapshot,
	HostTimer,
	RunEvidence,
} from "./types";

/**
 * The check library the frozen criteria name. Each check reads only host observations,
 * passively observed receipts and screen text; it never trusts what the tester said.
 * "violated" is positive evidence of a wrong state; "unmet" is a goal not (yet) reached;
 * "unknown" is missing evidence.
 */
export type CheckOutcome = {
	status: CheckStatus;
	code: string;
	detail?: string;
	class?: FailureClass;
};
type Ctx = {
	criteria: Criteria;
	ev: RunEvidence;
	initial: Map<string, HostTimer> | null;
	/** Timer ids that appear in some snapshot but not in the initial one. */
	newIds: string[];
};
type CheckDef<P> = {
	schema: z.ZodType<P>;
	run: (ctx: Ctx, params: P) => CheckOutcome;
};

const ok = (code: string, detail?: string): CheckOutcome => ({
	status: "met",
	code,
	detail,
});
const unmet = (code: string, detail?: string): CheckOutcome => ({
	status: "unmet",
	code,
	detail,
});
const violated = (code: string, detail?: string): CheckOutcome => ({
	status: "violated",
	code,
	detail,
});
const unknown = (
	code: string,
	detail?: string,
	cls?: FailureClass,
): CheckOutcome => ({ status: "unknown", code, detail, class: cls });

const target = z.string().regex(/^(new|seeded:.+)$/);
const seconds = (fallback: number) =>
	z.number().nonnegative().default(fallback);

export function buildContext(criteria: Criteria, ev: RunEvidence): Ctx {
	const first = ev.hostSeries[0];
	const initial = first ? new Map(first.timers.map((t) => [t.id, t])) : null;
	const newIds: string[] = [];
	if (initial)
		for (const snap of ev.hostSeries)
			for (const t of snap.timers)
				if (!initial.has(t.id) && !newIds.includes(t.id)) newIds.push(t.id);
	return { criteria, ev, initial, newIds };
}

type Point = {
	atMs: number;
	state: HostTimer["state"];
	revision: number;
	remaining: number;
};
function remainingOf(t: HostTimer, serverNowMs: number): number {
	return t.state === "active"
		? Math.max(0, (Date.parse(t.dueAt) - serverNowMs) / 1000)
		: t.remainingSeconds;
}
function pointsOf(series: HostSnapshot[], id: string): Point[] {
	const out: Point[] = [];
	for (const snap of series) {
		const t = snap.timers.find((x) => x.id === id);
		if (t)
			out.push({
				atMs: snap.atMs,
				state: t.state,
				revision: t.revision,
				remaining: remainingOf(t, snap.serverNowMs),
			});
	}
	return out;
}
/** Consecutive points in the same state and revision. */
function segmentsOf(points: Point[], state: HostTimer["state"]): Point[][] {
	const segments: Point[][] = [];
	let current: Point[] = [];
	for (const p of points) {
		const last = current[current.length - 1];
		if (p.state === state && (!last || last.revision === p.revision))
			current.push(p);
		else {
			if (current.length) segments.push(current);
			current = p.state === state ? [p] : [];
		}
	}
	if (current.length) segments.push(current);
	return segments;
}
/** The host's remaining time at a screen observation, extrapolated from the latest earlier snapshot. */
function hostRemainingAt(
	points: Point[],
	atMs: number,
): { state: HostTimer["state"]; remaining: number } | null {
	let k = -1;
	for (let i = 0; i < points.length; i++) if (points[i]!.atMs <= atMs) k = i;
	if (k < 0) return null;
	const p = points[k]!;
	if (atMs - p.atMs > 3000) return null;
	const next = points[k + 1];
	if (next && (next.state !== p.state || next.revision !== p.revision))
		return null;
	return {
		state: p.state,
		remaining:
			p.state === "active"
				? Math.max(0, p.remaining - (atMs - p.atMs) / 1000)
				: p.remaining,
	};
}
function resolve(ctx: Ctx, spec: string): string | null {
	if (spec === "new") return ctx.newIds.length === 1 ? ctx.newIds[0]! : null;
	const label = spec.slice("seeded:".length);
	const hits = [...(ctx.initial?.values() ?? [])].filter(
		(t) => t.label === label,
	);
	return hits.length === 1 ? hits[0]!.id : null;
}
const unresolved = (spec: string): CheckOutcome =>
	spec === "new"
		? unmet("target_unresolved", "新しいtimerがちょうど一件ではない")
		: unknown("target_unresolved", spec, "environment");

type Matched = { atMs: number; reading: number };
/** Screen observations whose clock reading agrees with the host (state filter optional). */
function screenMatches(
	ctx: Ctx,
	id: string,
	state: HostTimer["state"],
	tol: number,
	fromMs: number,
): { matches: Matched[]; anyReadings: boolean } {
	const points = pointsOf(ctx.ev.hostSeries, id);
	const matches: Matched[] = [];
	let anyReadings = false;
	for (const screen of ctx.ev.screens) {
		if (screen.atMs < fromMs) continue;
		const candidates = clockCandidates(screen.text);
		if (candidates.length) anyReadings = true;
		const host = hostRemainingAt(points, screen.atMs);
		if (!host || host.state !== state) continue;
		const reading = closestWithin(candidates, host.remaining, tol);
		if (reading !== null) matches.push({ atMs: screen.atMs, reading });
	}
	return { matches, anyReadings };
}
function lastReload(ctx: Ctx, afterReload: boolean): number {
	return afterReload ? (ctx.ev.reloads[ctx.ev.reloads.length - 1] ?? 0) : 0;
}
function startedReceipts(ctx: Ctx) {
	return [
		...new Map(
			ctx.ev.receipts
				.filter((r) => r.action === "started")
				.map((r) => [r.operationId, r]),
		).values(),
	];
}

const checks: Record<string, CheckDef<never>> = {};
function register<P>(name: string, def: CheckDef<P>) {
	checks[name] = def as unknown as CheckDef<never>;
}

register("new-timers", {
	schema: z.strictObject({
		count: z.number().int().min(0),
		durationSeconds: z.number().int().positive().optional(),
		origin: z.enum(["any", "conversation"]).default("any"),
		requireStartedReceipt: z.boolean().default(false),
	}),
	run(ctx, p) {
		if (!ctx.initial)
			return unknown("host_unobserved", undefined, "environment");
		const ids = ctx.newIds;
		const latest = ctx.ev.hostSeries[ctx.ev.hostSeries.length - 1]!;
		const timers = ids.map(
			(id) => latest.timers.find((t) => t.id === id) as HostTimer,
		);
		if (ids.length > p.count)
			return violated(
				"extra_timers",
				`新しいtimerが${ids.length}件（期待${p.count}件）`,
			);
		if (ids.length < p.count) {
			const markers = ctx.criteria.successMarkers.map(
				(m) => new RegExp(m, "i"),
			);
			const claimed = ctx.ev.screens.some((s) =>
				markers.some((m) => m.test(s.text)),
			);
			// The screen claims a result the host never saved: attributable to the product alone.
			return claimed
				? {
						...violated(
							"fake_success_display",
							"画面は開始成功を示すがhostに新しいtimerがない",
						),
						class: "product",
					}
				: unmet("no_new_timer", `新しいtimerが${ids.length}件`);
		}
		for (const t of timers) {
			if (
				p.durationSeconds !== undefined &&
				t.durationSeconds !== p.durationSeconds
			)
				return violated(
					"wrong_duration",
					`durationSeconds=${t.durationSeconds}（期待${p.durationSeconds}）`,
				);
			if (p.origin === "conversation" && t.originRunId === null)
				return unmet("origin_not_conversation", t.id);
		}
		if (p.requireStartedReceipt) {
			const started = startedReceipts(ctx);
			if (started.length > p.count)
				return violated(
					"duplicate_start",
					`started receipt ${started.length}件`,
				);
			if (started.length < p.count)
				return unknown(
					"receipt_unobserved",
					"started receiptを観測できていない",
				);
			const stray = started.find(
				(r) => r.timerId !== null && !ids.includes(r.timerId),
			);
			if (stray) return violated("receipt_for_other_timer", stray.operationId);
		}
		return ok("new_timers_match", `${ids.length}件`);
	},
});

register("remaining-decreases", {
	schema: z.strictObject({
		target,
		minSeparationSeconds: seconds(2),
		minDropSeconds: seconds(1),
		toleranceSeconds: seconds(2),
		screenRequired: z.boolean().default(true),
		screenMinSeparationSeconds: seconds(5),
		screenMinDropSeconds: seconds(1),
		afterReload: z.boolean().default(false),
	}),
	run(ctx, p) {
		const id = resolve(ctx, p.target);
		if (!id) return unresolved(p.target);
		const points = pointsOf(ctx.ev.hostSeries, id);
		const from = lastReload(ctx, p.afterReload);
		const segments = segmentsOf(points, "active").filter(
			(s) => s[s.length - 1]!.atMs >= from,
		);
		let spanned = false;
		let consistent = false;
		let wrong = "";
		for (const seg of segments) {
			const a = seg[0]!;
			const b = seg[seg.length - 1]!;
			const dt = (b.atMs - a.atMs) / 1000;
			if (dt < p.minSeparationSeconds) continue;
			spanned = true;
			const drop = a.remaining - b.remaining;
			if (drop >= p.minDropSeconds && Math.abs(drop - dt) <= p.toleranceSeconds)
				consistent = true;
			else if (b.remaining > 0)
				wrong = `${dt.toFixed(1)}秒間で残り${drop.toFixed(1)}秒しか減らない`;
		}
		if (!spanned)
			return unknown("insufficient_host_observation", "active区間が短すぎる");
		if (!consistent)
			return wrong
				? violated("remaining_not_decreasing", wrong)
				: unmet("host_decrease_unverified");
		if (!p.screenRequired) return ok("host_decrease_only");
		const { matches, anyReadings } = screenMatches(
			ctx,
			id,
			"active",
			p.toleranceSeconds,
			from,
		);
		for (let i = 0; i < matches.length; i++)
			for (let j = i + 1; j < matches.length; j++) {
				const a = matches[i]!;
				const b = matches[j]!;
				if (
					(b.atMs - a.atMs) / 1000 >= p.screenMinSeparationSeconds &&
					a.reading - b.reading >= p.screenMinDropSeconds
				)
					return ok("host_and_screen_decrease");
			}
		return anyReadings
			? unmet("screen_host_mismatch", "画面の残り時間がhostの値と合わない")
			: unknown("screen_clock_unreadable", "画面から残り時間を読めない");
	},
});

register("paused-remaining-stable", {
	schema: z.strictObject({
		target,
		minSeparationSeconds: seconds(2),
		toleranceSeconds: seconds(2),
		screenRequired: z.boolean().default(true),
		screenStableDeltaSeconds: seconds(1),
	}),
	run(ctx, p) {
		const id = resolve(ctx, p.target);
		if (!id) return unresolved(p.target);
		const points = pointsOf(ctx.ev.hostSeries, id);
		const segments = segmentsOf(points, "paused");
		if (!segments.length) return unmet("never_paused");
		let observed: Point[] | null = null;
		for (const seg of segments) {
			const dt = (seg[seg.length - 1]!.atMs - seg[0]!.atMs) / 1000;
			if (dt < p.minSeparationSeconds) continue;
			if (seg.some((x) => x.remaining !== seg[0]!.remaining))
				return violated(
					"remaining_changed_while_paused",
					`${seg[0]!.remaining}秒から${seg.map((x) => x.remaining).join(",")}`,
				);
			observed = seg;
		}
		if (!observed)
			return unknown("pause_too_short_to_observe", "paused観測が2秒未満");
		if (!p.screenRequired) return ok("host_stable_only");
		const from = observed[0]!.atMs;
		const to = observed[observed.length - 1]!.atMs;
		const { matches, anyReadings } = screenMatches(
			ctx,
			id,
			"paused",
			p.toleranceSeconds,
			from,
		);
		const inside = matches.filter((m) => m.atMs <= to);
		for (let i = 0; i < inside.length; i++)
			for (let j = i + 1; j < inside.length; j++)
				if (
					(inside[j]!.atMs - inside[i]!.atMs) / 1000 >=
						p.minSeparationSeconds &&
					Math.abs(inside[i]!.reading - inside[j]!.reading) <=
						p.screenStableDeltaSeconds
				)
					return ok("host_and_screen_stable");
		return anyReadings
			? unmet("screen_not_stable_or_mismatch")
			: unknown("screen_clock_unreadable", "画面から残り時間を読めない");
	},
});

register("resumed-same-timer", {
	schema: z.strictObject({
		target,
		minSeparationSeconds: seconds(2),
		minDropSeconds: seconds(1),
		toleranceSeconds: seconds(2),
		requireReceipt: z.boolean().default(false),
	}),
	run(ctx, p) {
		const id = resolve(ctx, p.target);
		if (!id) return unresolved(p.target);
		const points = pointsOf(ctx.ev.hostSeries, id);
		const paused = segmentsOf(points, "paused");
		const last = paused[paused.length - 1];
		if (!last) return unmet("never_paused");
		const pausedRevision = last[last.length - 1]!.revision;
		const afterPause = points.filter(
			(x) => x.atMs > last[last.length - 1]!.atMs,
		);
		const resumedFrom = afterPause.findIndex(
			(x) => x.state === "active" && x.revision > pausedRevision,
		);
		if (resumedFrom < 0) return unmet("not_resumed");
		const seg = segmentsOf(afterPause.slice(resumedFrom), "active")[0]!;
		const a = seg[0]!;
		const b = seg[seg.length - 1]!;
		const dt = (b.atMs - a.atMs) / 1000;
		if (dt < p.minSeparationSeconds)
			return unknown("resume_too_short_to_observe", "再開後の観測が2秒未満");
		const drop = a.remaining - b.remaining;
		if (drop < p.minDropSeconds || Math.abs(drop - dt) > p.toleranceSeconds)
			return violated("resumed_but_not_counting_down");
		if (
			p.requireReceipt &&
			!ctx.ev.receipts.some((r) => r.action === "resumed" && r.timerId === id)
		)
			return unknown("receipt_unobserved", "resumed receiptを観測できていない");
		return ok("resumed_same_timer");
	},
});

register("no-extra-side-effects", {
	schema: z.strictObject({
		maxNewTimers: z.number().int().min(0),
		maxStarted: z.number().int().min(0),
		allowedReceiptActions: z.array(z.string()).min(1),
		/** Seeded timers (by label) the goal allows to change. */
		mayChange: z.array(z.string()).default([]),
	}),
	run(ctx, p) {
		if (!ctx.initial)
			return unknown("host_unobserved", undefined, "environment");
		for (const snap of ctx.ev.hostSeries)
			for (const t of snap.timers) {
				const before = ctx.initial.get(t.id);
				if (
					before &&
					!p.mayChange.includes(before.label) &&
					(before.revision !== t.revision ||
						before.state !== t.state ||
						before.dueAt !== t.dueAt)
				)
					return violated("other_timer_modified", `${before.label}`);
			}
		if (ctx.newIds.length > p.maxNewTimers)
			return violated("extra_timers", `${ctx.newIds.length}件`);
		const bad = ctx.ev.receipts.find(
			(r) => !p.allowedReceiptActions.includes(r.action),
		);
		if (bad) return violated("unexpected_receipt_action", bad.action);
		if (startedReceipts(ctx).length > p.maxStarted)
			return violated("duplicate_start");
		const known = new Set([
			...ctx.newIds,
			...[...ctx.initial.values()]
				.filter((t) => p.mayChange.includes(t.label))
				.map((t) => t.id),
		]);
		const stray = ctx.ev.receipts.find(
			(r) => r.timerId !== null && !known.has(r.timerId),
		);
		if (stray) return violated("receipt_for_other_timer", stray.action);
		return ok("no_extra_side_effects");
	},
});

register("timer-final-state", {
	schema: z.strictObject({
		target,
		state: z.enum(["active", "paused", "elapsed", "cancelled"]),
		durationSeconds: z.number().int().positive().optional(),
	}),
	run(ctx, p) {
		const id = resolve(ctx, p.target);
		if (!id) return unresolved(p.target);
		const latest = ctx.ev.hostSeries[ctx.ev.hostSeries.length - 1]!;
		const t = latest.timers.find((x) => x.id === id);
		if (!t) return unknown("target_missing", undefined, "environment");
		if (
			p.durationSeconds !== undefined &&
			t.durationSeconds !== p.durationSeconds
		)
			return violated("wrong_duration", `${t.durationSeconds}`);
		return t.state === p.state
			? ok("state_reached", t.state)
			: unmet("state_not_reached", `${t.state}（期待${p.state}）`);
	},
});

register("timer-unchanged", {
	schema: z.strictObject({ target }),
	run(ctx, p) {
		const id = resolve(ctx, p.target);
		if (!id) return unresolved(p.target);
		const before = ctx.initial?.get(id);
		const latest = ctx.ev.hostSeries[ctx.ev.hostSeries.length - 1]!;
		const now = latest.timers.find((x) => x.id === id);
		if (!before || !now)
			return unknown("target_missing", undefined, "environment");
		return before.revision === now.revision && before.state === now.state
			? ok("unchanged")
			: violated("timer_modified", `${now.state}@${now.revision}`);
	},
});

register("screen-mentions", {
	schema: z.strictObject({
		sets: z
			.array(
				z.strictObject({
					id: z.string(),
					patterns: z.array(z.string()).min(1),
					minObservations: z.number().int().positive().default(1),
				}),
			)
			.min(1),
	}),
	run(ctx, p) {
		if (!ctx.ev.screens.length) return unknown("no_screen_evidence");
		for (const set of p.sets) {
			const patterns = set.patterns.map((x) => new RegExp(x, "i"));
			const hits = ctx.ev.screens.filter((s) =>
				patterns.some((x) => x.test(s.text)),
			).length;
			if (hits < set.minObservations)
				return unmet("screen_text_missing", set.id);
		}
		return ok("screen_text_present");
	},
});

register("interaction-lifecycle", {
	schema: z.strictObject({
		sequence: z.array(z.string()).min(2),
		maxQuestions: z.number().int().positive(),
		requireReceiptRef: z.boolean().default(true),
		/** The page was reloaded between the first and the last status of `sequence`. */
		reloadBetween: z.boolean().default(false),
	}),
	run(ctx, p) {
		const series = ctx.ev.hostSeries.filter((s) => s.interactions !== null);
		if (!series.length)
			return unknown("interactions_unobserved", undefined, "environment");
		const ids = new Set(
			series.flatMap((s) => s.interactions!.map((i) => i.id)),
		);
		if (ids.size > 1) return violated("multiple_interactions", `${ids.size}件`);
		const [id] = [...ids];
		if (!id) return unmet("no_interaction");
		const views = series.map((s) => ({
			atMs: s.atMs,
			view: s.interactions!.find((i) => i.id === id),
		}));
		let next = 0;
		let firstAt: number | null = null;
		let lastAt = 0;
		for (const { atMs, view } of views) {
			if (view && view.status === p.sequence[next]) {
				if (next === 0) firstAt = atMs;
				lastAt = atMs;
				next++;
				if (next === p.sequence.length) break;
			}
		}
		if (next < p.sequence.length)
			return unmet("sequence_not_observed", `${next}/${p.sequence.length}`);
		const final = views[views.length - 1]!.view!;
		if (final.questionCount > p.maxQuestions)
			return violated("question_limit_exceeded", `${final.questionCount}`);
		if (p.requireReceiptRef && !final.hasReceiptRef)
			return unmet("receipt_ref_missing");
		if (
			p.reloadBetween &&
			!ctx.ev.reloads.some(
				(t) => firstAt !== null && t >= firstAt && t <= lastAt,
			)
		)
			return unmet("no_reload_while_waiting");
		return ok("interaction_completed");
	},
});

register("page-reloaded", {
	schema: z.strictObject({ min: z.number().int().positive() }),
	run(ctx, p) {
		return ctx.ev.reloads.length >= p.min
			? ok("page_reloaded", `${ctx.ev.reloads.length}回`)
			: unmet("page_not_reloaded");
	},
});

register("fault-triggered", {
	schema: z.strictObject({ kind: z.string() }),
	run(ctx, p) {
		return ctx.ev.faultsTriggered.some((f) => f.kind === p.kind)
			? ok("fault_triggered")
			: unknown("fault_not_triggered", p.kind, "environment");
	},
});

export function checkNames(): string[] {
	return Object.keys(checks);
}
/** Validates every item's check name and parameters, listing all problems. */
export function validateCriteriaItems(criteria: Criteria): string[] {
	const issues: string[] = [];
	for (const item of criteria.items) {
		const def = checks[item.check] as CheckDef<unknown> | undefined;
		if (!def) issues.push(`${item.id}: unknown_check ${item.check}`);
		else {
			const parsed = def.schema.safeParse(item.params);
			if (!parsed.success)
				issues.push(
					`${item.id}: invalid_params ${parsed.error.issues[0]?.path.join(".")}`,
				);
		}
	}
	return issues;
}
export function runCheck(
	ctx: Ctx,
	item: Criteria["items"][number],
): CheckOutcome {
	const def = checks[item.check] as CheckDef<unknown> | undefined;
	const parsed = def?.schema.safeParse(item.params);
	if (!def || !parsed?.success)
		return unknown("criteria_invalid", item.check, "criteria");
	return def.run(ctx, parsed.data);
}
