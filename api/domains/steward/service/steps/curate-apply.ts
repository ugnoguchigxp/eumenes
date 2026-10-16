import {
	FORGET_MAX_ITEMS,
	type CurationItem,
	type CurationResult,
} from "../../../memory";
import { MAX_FAILURES } from "../../contracts";
import { bumpInboxFailure, resolveInbox } from "../../repository";
import {
	FORGET_LIMIT_NOTICE,
	NOTHING_TO_FORGET_NOTICE,
	REQUEST_FAILED_NOTICE,
} from "../notices";
import type { MemoryRef } from "../context";
import { relatedToRequest } from "../relevance";
import { type ForgetSpec, executeForget } from "./curate-forget";
import { recordRoutes } from "./curate-route";
import type { ApplyResult, PreparedUnit, StepEnv } from "../types";
import type {
	CurateContext,
	CurateExtras,
	CurateOutput,
	RequestEntry,
	Resolve,
	TurnVectors,
} from "./curate-types";

// ---- apply ----

type Source = {
	section: "remember" | "update" | "stop" | "notes" | "resolve";
	index: number;
	request?: string;
};

function noticeFor(
	action: Resolve["action"],
	applied: boolean,
	code: string | null,
): string {
	if (code === "forget_limit") return FORGET_LIMIT_NOTICE;
	if (code === "nothing_to_forget" || code === "unrelated_target")
		return NOTHING_TO_FORGET_NOTICE;
	if (code === "world_unavailable")
		return "世界の記録に今は触れないため、忘れる依頼は実行できませんでした。";
	if (code === "evidence_incomplete")
		return "世界の記録の根拠を最後まで確認できず、すべてを忘れることができないため、忘れる依頼は実行しませんでした。もう一度お願いします。";
	if (!applied) return "記憶の依頼は実行できませんでした。";
	switch (action) {
		case "forget":
			return "忘れる依頼を実行しました。";
		case "remember":
			return "覚える依頼を保存しました。";
		case "update":
			return "訂正の依頼を反映しました。";
		case "stop":
			return "依頼された記憶の利用を止めました。";
		default:
			return "記憶の依頼は実行できませんでした。";
	}
}

/** The goals linked to the given World entities (what the entity forget deletes with them). */
type GoalsTiedTo = (entityIds: readonly string[]) => ReadonlySet<string>;

type Entry = { item: CurationItem; source: Source };
/** A forget the curation asks for: one per request, applied before anything else of the unit. */
type PlannedForget = ForgetSpec & { request: string; source: Source };

class Plan {
	entries: Entry[] = [];
	forgets: PlannedForget[] = [];
	rejected: Array<{ source: Source; code: string }> = [];
	/** Targets of a forget that did not relate to the request and were left out while the rest went on. */
	unrelated: Array<{ source: Source; count: number }> = [];
	add(item: CurationItem, source: Source) {
		this.entries.push({ item, source });
	}
	reject(source: Source, code: string) {
		this.rejected.push({ source, code });
	}
}

function planOutput(
	context: CurateContext,
	output: CurateOutput,
	extras: Pick<CurateExtras, "candidates" | "candidateTexts">,
	goalsTiedTo: GoalsTiedTo,
) {
	const plan = new Plan();
	const messageOf = (label: string) => context.exchanges[label]?.inputMessageId;
	// The notes have no evidence of their own: they stand on every exchange the unit read (conservative).
	const noteSources = [
		...new Set(Object.values(context.exchanges).map((e) => e.inputMessageId)),
	];
	const stateRef = (ref: string) => {
		const found = context.refs[ref];
		return found?.namespace === "state" ? found : undefined;
	};
	output.remember.forEach((e, index) => {
		const source: Source = { section: "remember", index };
		const messageId = messageOf(e.evidence);
		if (!messageId) return plan.reject(source, "unknown_evidence");
		plan.add(
			{
				op: "remember",
				kind: e.kind,
				key: e.key,
				text: e.text,
				negated: e.negated,
				messageId,
				quote: e.quote,
				validFrom: e.validFrom,
				validUntil: e.validUntil,
			},
			source,
		);
	});
	output.update.forEach((e, index) => {
		const source: Source = { section: "update", index };
		const messageId = messageOf(e.evidence);
		const ref = stateRef(e.ref);
		if (!messageId || !ref) return plan.reject(source, "unknown_ref");
		plan.add(
			{
				op: "update",
				itemId: ref.id,
				revision: ref.revision,
				text: e.text,
				...(e.negated === undefined ? {} : { negated: e.negated }),
				messageId,
				quote: e.quote,
			},
			source,
		);
	});
	output.stop.forEach((e, index) => {
		const source: Source = { section: "stop", index };
		const ref = stateRef(e.ref);
		if (!ref) return plan.reject(source, "unknown_ref");
		plan.add({ op: "stop", itemId: ref.id, revision: ref.revision }, source);
	});
	// Compared without spaces and punctuation, so a re-worded copy with the same words is caught too.
	const fold = (text: string) =>
		text.normalize("NFKC").replace(/[\s、。,.!?！？「」『』（）()・]/g, "");
	const notes = new Set(context.noteTexts.map(fold));
	output.notes.forEach((e, index) => {
		const source: Source = { section: "notes", index };
		if (e.op === "add" && notes.has(fold(e.text!)))
			return plan.reject(source, "duplicate_note");
		if (e.op === "add") notes.add(fold(e.text!));
		if (e.op === "add")
			return plan.add(
				{
					op: "note_add",
					kind: e.kind ?? "memo",
					text: e.text!,
					messageIds: noteSources,
				},
				source,
			);
		const ref = e.ref ? context.refs[e.ref] : undefined;
		if (ref?.namespace !== "continuity")
			return plan.reject(source, "unknown_ref");
		if (e.op === "update")
			return plan.add(
				{
					op: "note_update",
					noteId: ref.id,
					revision: ref.revision,
					text: e.text!,
					messageIds: noteSources,
				},
				source,
			);
		plan.add(
			{
				op: "note_close",
				noteId: ref.id,
				revision: ref.revision,
				status: e.status!,
			},
			source,
		);
	});
	const answered = new Set<string>();
	output.resolve.forEach((e, index) => {
		const request = context.requests[e.request];
		// Only a request this unit gave is answered: a label that names none ends the element (never matched by kind).
		if (!request)
			return plan.reject({ section: "resolve", index }, "unknown_request");
		const source: Source = { section: "resolve", index, request: e.request };
		if (answered.has(e.request)) return;
		answered.add(e.request);
		planResolve(plan, context, extras, goalsTiedTo, e, request, source);
	});
	return { plan, answered };
}

function planResolve(
	plan: Plan,
	context: CurateContext,
	extras: Pick<CurateExtras, "candidates" | "candidateTexts">,
	goalsTiedTo: GoalsTiedTo,
	e: Resolve,
	request: RequestEntry,
	source: Source,
) {
	const states = e.refs
		.map((ref) => context.refs[ref])
		.filter((ref): ref is MemoryRef => ref?.namespace === "state");
	switch (e.action) {
		case "forget": {
			// Only what the model was shown can be forgotten: a ref that is not in the list it read ends the whole
			// resolution (an injected or invented ref must not pick an item).
			if (e.refs.some((ref) => context.refs[ref] === undefined))
				return plan.reject(source, "unknown_ref");
			// And only what has to do with the words of the request: the model can err, or be steered by what it read.
			const asked = `${request.what} ${request.detail ?? ""}`;
			let unrelated = 0;
			const forgettable = new Set<MemoryRef["namespace"]>([
				"state",
				"claim",
				"entity",
				"goal",
			]);
			const related = e.refs.filter((ref) => {
				if (!forgettable.has(context.refs[ref]!.namespace)) return true;
				if (relatedToRequest(asked, context.shown[ref] ?? [])) return true;
				unrelated++;
				return false;
			});
			// What a chosen entity already takes with it is not counted again (nor named twice): the claims about it
			// and the goals tied to it.
			const chosenEntities = new Set(
				related
					.map((ref) => context.refs[ref]!)
					.filter((ref) => ref.namespace === "entity")
					.map((ref) => ref.id),
			);
			const tied = goalsTiedTo([...chosenEntities]);
			const refs = related.filter((ref) => {
				const target = context.refs[ref]!;
				if (target.namespace === "claim")
					return !(context.claimEntities[ref] ?? []).some((id) =>
						chosenEntities.has(id),
					);
				if (target.namespace === "goal") return !tied.has(target.id);
				return true;
			});
			const named = (namespace: MemoryRef["namespace"]) => [
				...new Set(
					refs
						.map((ref) => context.refs[ref])
						.filter((ref): ref is MemoryRef => ref?.namespace === namespace)
						.map((ref) => ref.id),
				),
			];
			const itemIds = named("state");
			const claimIds = named("claim");
			const entityIds = named("entity");
			const goalIds = named("goal");
			// One request removes at most five things in all, whichever shelf they are on (F3).
			if (
				itemIds.length > FORGET_MAX_ITEMS ||
				itemIds.length + claimIds.length + entityIds.length + goalIds.length >
					FORGET_MAX_ITEMS
			)
				return plan.reject(source, "forget_limit");
			// The exchange the request was made in is the request itself: alone it is nothing to forget.
			const own = new Set<string>();
			const others = new Set<string>();
			for (const label of e.alsoIn) {
				const exchange = context.exchanges[label];
				const candidate = extras.candidates[label];
				if (!exchange && !candidate) continue;
				const userText =
					context.exchangeTexts[label] ?? extras.candidateTexts[label] ?? "";
				if (!relatedToRequest(asked, [userText])) {
					unrelated++;
					continue;
				}
				const into = label === request.exchange ? own : others;
				if (exchange) {
					into.add(exchange.inputMessageId);
					if (exchange.answerMessageId) into.add(exchange.answerMessageId);
				}
				for (const id of candidate ?? []) into.add(id);
			}
			const messageIds = new Set([...own, ...others]);
			if (
				itemIds.length +
					claimIds.length +
					entityIds.length +
					goalIds.length +
					others.size ===
				0
			)
				return plan.reject(
					source,
					unrelated > 0 ? "unrelated_target" : "nothing_to_forget",
				);
			if (unrelated > 0) plan.unrelated.push({ source, count: unrelated });
			plan.forgets.push({
				request: e.request,
				source,
				itemIds,
				messageIds: [...messageIds],
				claimIds,
				entityIds,
				goalIds,
			});
			return;
		}
		case "stop": {
			const ref = states[0];
			if (!ref) return plan.reject(source, "unknown_ref");
			return plan.add(
				{ op: "stop", itemId: ref.id, revision: ref.revision },
				source,
			);
		}
		case "remember": {
			const ref = states[0];
			if (ref)
				return plan.add(
					{
						op: "update",
						itemId: ref.id,
						revision: ref.revision,
						text: e.text ?? "",
						...(e.negated === undefined ? {} : { negated: e.negated }),
						messageId: request.messageId,
						explicit: true,
					},
					source,
				);
			if (!e.kind || !e.key || !e.text)
				return plan.reject(source, "invalid_input");
			return plan.add(
				{
					op: "remember",
					kind: e.kind,
					key: e.key,
					text: e.text,
					...(e.negated === undefined ? {} : { negated: e.negated }),
					messageId: request.messageId,
					explicit: true,
				},
				source,
			);
		}
		case "update": {
			const ref = states[0];
			if (!ref || !e.text) return plan.reject(source, "unknown_ref");
			return plan.add(
				{
					op: "update",
					itemId: ref.id,
					revision: ref.revision,
					text: e.text,
					...(e.negated === undefined ? {} : { negated: e.negated }),
					messageId: request.messageId,
					explicit: true,
				},
				source,
			);
		}
		default:
			return plan.reject(source, "no_action");
	}
}

/**
 * A `remember` request that pointed at an item and wrote no new wording keeps the item's own text. A request to
 * remember is never answered with "nothing to do" when the model found the item already there: the user asked,
 * so the item is saved again as the version the user confirmed (K14), with its own text, not the model's reason.
 */
function withKeptText(
	env: StepEnv,
	context: CurateContext,
	output: CurateOutput,
): CurateOutput {
	const items = env.deps.memory.stateItemsInTransaction(env.db, false);
	const known = new Map(
		items.map((item) => [item.itemId, item.value] as const),
	);
	// The ref of the stored item with the request's key (the model may name the key but cite the wrong ref).
	const refOfKey = (key: string | null) => {
		const wanted = key?.trim().toLowerCase();
		const item = wanted && items.find((i) => i.semanticKey === wanted);
		if (!item) return undefined;
		return Object.entries(context.refs).find(
			([, r]) => r.namespace === "state" && r.id === item.itemId,
		)?.[0];
	};
	return {
		...output,
		resolve: output.resolve.map((raw) => {
			const asked = context.requests[raw.request]?.kind === "remember";
			const pointed =
				raw.refs.find((r) => context.refs[r]?.namespace === "state") ??
				(asked && raw.action === "none" ? refOfKey(raw.key) : undefined);
			const e =
				asked && raw.action === "none" && pointed
					? { ...raw, action: "remember" as const, refs: [pointed], text: null }
					: raw;
			if (e.action !== "remember" || e.text) return e;
			const ref = e.refs
				.map((r) => context.refs[r])
				.find((r) => r?.namespace === "state");
			const existing = ref ? known.get(ref.id) : undefined;
			return existing
				? {
						...e,
						text: existing.text,
						negated: existing.polarity === "negated",
					}
				: e;
		}),
	};
}

function describeResult(
	source: Source,
	result: CurationResult | { status: "rejected"; reason: string },
) {
	const base = { section: source.section, index: source.index } as Record<
		string,
		unknown
	>;
	if (result.status === "rejected")
		return { ...base, status: "rejected", code: result.reason };
	return {
		...base,
		status: "applied",
		...(result.id ? { itemId: result.id } : {}),
		changed: result.changed,
		...(result.quoteMatched === null
			? {}
			: { quoteMatched: result.quoteMatched }),
		...(result.reconfirmed ? { reconfirmed: true } : {}),
	};
}

/** What a forget left behind: the messages blocked and the items gone (the other curation of the unit must not use them). */
type Forgotten = { blocked: Set<string>; items: Set<string> };

/**
 * An element that stands on a forgotten message or item is dropped (B1-B3, section 6.1): the forget runs first, so
 * the unit never saves, updates or notes anything from what the user asked to forget.
 */
function survives(item: CurationItem, gone: Forgotten): string | null {
	const blockedAmong = (ids: readonly string[]) =>
		ids.some((id) => gone.blocked.has(id));
	switch (item.op) {
		case "remember":
			return gone.blocked.has(item.messageId) ? "blocked_source" : null;
		case "update":
			if (gone.items.has(item.itemId)) return "unknown_item";
			return gone.blocked.has(item.messageId) ? "blocked_source" : null;
		case "stop":
			return gone.items.has(item.itemId) ? "unknown_item" : null;
		case "note_add":
			return blockedAmong(item.messageIds) ? "blocked_source" : null;
		case "note_update":
			return item.messageIds && blockedAmong(item.messageIds)
				? "blocked_source"
				: null;
		default:
			return null;
	}
}

export function applyCurate(
	env: StepEnv,
	prepared: PreparedUnit,
	rawOutput: unknown,
	rawExtras: unknown,
): ApplyResult {
	const { db, deps, conversationId } = env;
	const context = prepared.context as CurateContext;
	const extras = rawExtras as CurateExtras;
	const output = withKeptText(env, context, rawOutput as CurateOutput);
	const { plan, answered } = planOutput(context, output, extras, (entityIds) =>
		entityIds.length > 0 && deps.goals
			? new Set(
					deps.goals.ops.resolveForgetInTransaction(db, {
						goalIds: [],
						entityIds: [...entityIds],
					}).goalIds,
				)
			: new Set(),
	);
	const described: unknown[] = [];
	const refs: ApplyResult["refs"] = [];
	const outcomeOf = new Map<
		string,
		{ applied: boolean; action: Resolve["action"]; code: string | null }
	>();
	let applied = 0;
	let rejected = output.dropped;
	let changed = false;
	let redact = false;
	const reject = (source: Source, code: string) => {
		rejected++;
		described.push(
			describeResult(source, { status: "rejected", reason: code }),
		);
		if (source.request)
			outcomeOf.set(source.request, {
				applied: false,
				action: output.resolve[source.index]!.action,
				code,
			});
	};

	// 1. The forgets, before anything else of the unit.
	const gone: Forgotten = { blocked: new Set(), items: new Set() };
	for (const spec of plan.forgets) {
		const itemIds = spec.itemIds.filter((id) => !gone.items.has(id));
		const messageIds = spec.messageIds.filter((id) => !gone.blocked.has(id));
		const record = (code: string) => {
			applied++;
			outcomeOf.set(spec.request, {
				applied: true,
				action: "forget",
				code: null,
			});
			described.push({
				section: "resolve",
				request: spec.request,
				status: "applied",
				code,
			});
		};
		// An earlier request of this unit already forgot all of it.
		if (
			itemIds.length +
				messageIds.length +
				spec.claimIds.length +
				spec.entityIds.length +
				spec.goalIds.length ===
			0
		) {
			record("forgotten");
			continue;
		}
		const effect = executeForget(env, { ...spec, itemIds, messageIds });
		// The memory or World refused this one: this request ends without forgetting anything.
		if (effect.status === "refused") {
			reject(spec.source, effect.code);
			continue;
		}
		for (const id of effect.blockedMessageIds) gone.blocked.add(id);
		for (const id of effect.itemIds) gone.items.add(id);
		redact = true;
		changed = true;
		record("forgotten");
	}

	// 2. The rest of the curation, without what the forget took.
	const kept: Entry[] = [];
	for (const entry of plan.entries) {
		const why = survives(entry.item, gone);
		if (why === null) kept.push(entry);
		else plan.reject(entry.source, why);
	}
	const results = deps.memory.applyCurationInTransaction(db, {
		conversationId,
		items: kept.map((entry) => entry.item),
	});
	results.forEach((result, i) => {
		const source = kept[i]!.source;
		described.push(describeResult(source, result));
		if (result.status === "applied") {
			applied++;
			if (result.changed) changed = true;
			if (result.id) refs.push({ type: "item", id: result.id });
			for (const id of result.stoppedIds) refs.push({ type: "item", id });
		} else rejected++;
		if (source.request)
			outcomeOf.set(source.request, {
				applied: result.status === "applied",
				action: output.resolve[source.index]!.action,
				code: result.status === "rejected" ? result.reason : null,
			});
	});
	for (const { source, code } of plan.rejected) reject(source, code);
	for (const { source, count } of plan.unrelated) {
		rejected += count;
		described.push({
			section: "resolve",
			index: source.index,
			status: "rejected",
			code: "unrelated_target",
			count,
		});
	}

	const notices = new Set<string>();
	const now = deps.clock();
	for (const [label, request] of Object.entries(context.requests)) {
		refs.push({ type: "request", id: request.id });
		const outcome = outcomeOf.get(label);
		if (outcome) {
			// A forget of this unit may have blocked the request's own message: the purge ended it as `forgotten`,
			// but the forget succeeded, so the request ends `done` with the usual notice.
			if (outcome.applied)
				resolveInbox(db, request.id, "done", outcome.code, now, true);
			else
				resolveInbox(
					db,
					request.id,
					"none",
					outcome.code ?? "not_applied",
					now,
					true,
				);
			notices.add(noticeFor(outcome.action, outcome.applied, outcome.code));
			changed = true;
		} else if (!answered.has(label)) {
			rejected++;
			if (bumpInboxFailure(db, request.id) >= MAX_FAILURES) {
				resolveInbox(db, request.id, "none", "steward_failed", now);
				notices.add(REQUEST_FAILED_NOTICE);
			}
		}
	}
	for (const id of context.targetIds)
		deps.memory.markExchangeStepInTransaction(db, id, "curated", "done");
	recordRoutes(env, context, output.route);
	deps.memory.vectors.saveTurnVectors(
		db,
		{ conversationId, digests: context.digests },
		extras.turnVectors as TurnVectors,
	);
	const messageIds = new Set(
		Object.values(context.exchanges).flatMap((e) =>
			[e.inputMessageId, e.answerMessageId].filter(
				(id): id is string => id !== null,
			),
		),
	);
	for (const id of messageIds) refs.push({ type: "message", id });
	return {
		applied,
		rejected,
		output: redact ? { redacted: "forgotten" } : output,
		results: described,
		refs,
		notices: [...notices],
		changed,
		redact,
	};
}
