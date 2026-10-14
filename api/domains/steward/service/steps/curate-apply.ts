import {
	FORGET_MAX_ITEMS,
	type CurationItem,
	type CurationResult,
} from "../../../memory";
import { MAX_FAILURES } from "../../contracts";
import { bumpInboxFailure, resolveInbox } from "../../repository";
import { FORGET_LIMIT_NOTICE, REQUEST_FAILED_NOTICE } from "../notices";
import type { MemoryRef } from "../context";
import type { ApplyResult, PreparedUnit, StepEnv } from "../types";
import type {
	Candidates,
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

type Entry = { item: CurationItem; source: Source };
/** A forget the curation asks for: one per request, applied before anything else of the unit. */
type ForgetSpec = {
	request: string;
	source: Source;
	itemIds: string[];
	messageIds: string[];
};

class Plan {
	entries: Entry[] = [];
	forgets: ForgetSpec[] = [];
	rejected: Array<{ source: Source; code: string }> = [];
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
	candidates: Candidates,
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
		const source: Source = { section: "resolve", index, request: e.request };
		if (!request || answered.has(e.request)) return;
		answered.add(e.request);
		planResolve(plan, context, candidates, e, request, source);
	});
	return { plan, answered };
}

function planResolve(
	plan: Plan,
	context: CurateContext,
	candidates: Candidates,
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
			const itemIds = [...new Set(states.map((ref) => ref.id))];
			if (itemIds.length > FORGET_MAX_ITEMS)
				return plan.reject(source, "forget_limit");
			const messageIds = new Set<string>();
			for (const label of e.alsoIn) {
				const exchange = context.exchanges[label];
				if (exchange) {
					messageIds.add(exchange.inputMessageId);
					if (exchange.answerMessageId)
						messageIds.add(exchange.answerMessageId);
				}
				for (const id of candidates[label] ?? []) messageIds.add(id);
			}
			if (itemIds.length + messageIds.size === 0)
				return plan.reject(source, "nothing_to_forget");
			plan.forgets.push({
				request: e.request,
				source,
				itemIds,
				messageIds: [...messageIds],
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
		items.map((item) => [item.itemId, item.value.text] as const),
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
			return existing ? { ...e, text: existing } : e;
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

const isForgetLimit = (error: unknown) =>
	error instanceof Error && error.message === "forget_limit";

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
	const { plan, answered } = planOutput(context, output, extras.candidates);
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
		if (itemIds.length === 0 && messageIds.length === 0) {
			record("forgotten");
			continue;
		}
		try {
			const outcome = deps.memory.forgetInTransaction(db, {
				conversationId,
				itemIds,
				messageIds,
			});
			for (const id of outcome.blockedMessageIds) gone.blocked.add(id);
			for (const id of outcome.forgottenItemIds) gone.items.add(id);
		} catch (error) {
			// The memory refused this many at once: this request ends without forgetting anything.
			if (!isForgetLimit(error)) throw error;
			reject(spec.source, "forget_limit");
			continue;
		}
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
