import { estimateTextTokens } from "../../../../infrastructure/context-budget";
import type { CurationItem, CurationResult } from "../../../memory";
import {
	COMPACT_THRESHOLD,
	REFINE_THRESHOLD,
	type StepId,
} from "../../contracts";
import { fitExchanges } from "../budget";
import {
	type MemoryRef,
	activeStateItems,
	describeMemory,
	elements,
	isRecord,
	labels,
	loadExchange,
	localDay,
	oneOf,
	optionalText,
	text,
	type LoadedExchange,
} from "../context";
import { instructions as compactInstructions } from "../prompts/compact-history";
import { instructions as consolidateInstructions } from "../prompts/consolidate-memory";
import { instructions as refineInstructions } from "../prompts/refine-summary";
import { compactSchema, consolidateSchema, refineSchema } from "../schemas";
import type {
	ApplyResult,
	PreparedUnit,
	StepDefinition,
	StepEnv,
} from "../types";
import { goalsEligible } from "./consolidate-goals";
import { allMessageIds, labelExchanges, withSummarySources } from "./shared";

const SUMMARY_CHARS = 1200;

// ---- eligibility (the kick asks before it makes a unit) ----

/**
 * Estimated tokens the memory and the verbatim history take of the memory and history budget: the long-term and
 * short-term layers, the summary and the recalled exchanges as the stored window carries them, and the exchanges
 * kept verbatim (each message whole).
 */
function memoryHistoryTokens(env: StepEnv): number {
	const { db, deps, conversationId } = env;
	const window = deps.memory.windows.storedInTransaction(db, conversationId);
	let tokens = window
		? window.longTerm.tokens +
			window.shortTerm.tokens +
			window.prefetch.tokens +
			estimateTextTokens(window.history.summaryText)
		: 0;
	const rows = deps.memory
		.exchangesInTransaction(db, conversationId)
		.filter((row) => row.disposition === "keep");
	const blocked = deps.memory.blockedMessageIdsInTransaction(
		db,
		rows.flatMap((r) => [
			r.inputMessageId,
			...(r.answerMessageId ? [r.answerMessageId] : []),
		]),
	);
	for (const row of rows) {
		for (const id of [row.inputMessageId, row.answerMessageId]) {
			if (id === null || blocked.has(id)) continue;
			const found = deps.conversation.messageInTransaction(db, id);
			if (found) tokens += estimateTextTokens(found.message.text);
		}
	}
	return tokens;
}
const summaryChars = (env: StepEnv): number =>
	[
		...(env.deps.memory.summaryInTransaction(env.db, env.conversationId)
			?.text ?? ""),
	].length;

/** Whether the step has anything to look at now (a quiet step is not asked again until the revision moves). */
export function eligible(env: StepEnv, step: StepId): boolean {
	switch (step) {
		case "consolidate-memory":
			return activeStateItems(env).length >= 2;
		case "compact-history":
			return (
				memoryHistoryTokens(env) >=
				env.deps.memory.historyBudgetTokens() * COMPACT_THRESHOLD
			);
		case "refine-summary":
			return summaryChars(env) >= SUMMARY_CHARS * REFINE_THRESHOLD;
		case "consolidate-goals":
			return goalsEligible(env);
		default:
			return false;
	}
}

// ---- consolidate-memory ----

type ConsolidateOutput = {
	merge: Array<{
		refs: string[];
		key: string | null;
		text: string;
		negated?: boolean;
	}>;
	stop: Array<{ ref: string; why: "outdated" | "duplicate" | "wrong" }>;
	tendencies: Array<{
		op: "add" | "update" | "retire";
		ref: string | null;
		text: string | null;
		evidenceRefs: string[];
	}>;
	republishLongTerm: boolean;
	changed: boolean;
	dropped: number;
};
type ConsolidateContext = { refs: Record<string, MemoryRef> };

function parseConsolidate(raw: unknown): ConsolidateOutput | null {
	if (!isRecord(raw)) return null;
	let dropped = 0;
	const take = <T>(r: { items: T[]; dropped: number }) => {
		dropped += r.dropped;
		return r.items;
	};
	const merge = take(
		elements(
			raw.merge,
			(e) => {
				const body = text(e.text, 500);
				const refs = labels(e.refs);
				return body && refs.length >= 2
					? {
							refs,
							key: optionalText(e.key, 200),
							text: body,
							...(typeof e.negated === "boolean" ? { negated: e.negated } : {}),
						}
					: null;
			},
			6,
		),
	);
	const stop = take(
		elements(
			raw.stop,
			(e) => {
				const ref = text(e.ref, 16);
				const why = oneOf(e.why, ["outdated", "duplicate", "wrong"] as const);
				return ref && why ? { ref, why } : null;
			},
			6,
		),
	);
	const tendencies = take(
		elements(
			raw.tendencies,
			(e) => {
				const op = oneOf(e.op, ["add", "update", "retire"] as const);
				if (!op) return null;
				const body = optionalText(e.text, 300);
				const ref = optionalText(e.ref, 16);
				if (op !== "add" && !ref) return null;
				if (op !== "retire" && !body) return null;
				return { op, ref, text: body, evidenceRefs: labels(e.evidenceRefs) };
			},
			4,
		),
	);
	return {
		merge,
		stop,
		tendencies,
		republishLongTerm: raw.republishLongTerm === true,
		changed: raw.changed === true,
		dropped,
	};
}

function prepareConsolidate(env: StepEnv) {
	if (activeStateItems(env).length < 2)
		return { status: "stale" as const, reason: "nothing_to_do" };
	const memory = describeMemory(env);
	return {
		status: "ready" as const,
		data: {
			today: localDay(env.deps.nowMs()),
			longTerm: memory.longTerm,
			longTermCoverage: memory.coverage,
		},
		targets: {},
		summaryRevision: null,
		context: { refs: memory.refs } satisfies ConsolidateContext,
	};
}

function planConsolidate(
	context: ConsolidateContext,
	output: ConsolidateOutput,
) {
	const items: CurationItem[] = [];
	const kinds: string[] = [];
	const state = (ref: string) => {
		const found = context.refs[ref];
		return found?.namespace === "state" ? found : undefined;
	};
	for (const e of output.merge) {
		const sources = [...new Set(e.refs)].map(state);
		if (sources.some((s) => !s) || sources.length < 2) continue;
		items.push({
			op: "merge",
			sources: sources.map((s) => ({ itemId: s!.id, revision: s!.revision })),
			key: e.key,
			text: e.text,
			...(e.negated === undefined ? {} : { negated: e.negated }),
		});
		kinds.push("merge");
	}
	for (const e of output.stop) {
		const ref = state(e.ref);
		if (!ref) continue;
		items.push({ op: "stop", itemId: ref.id, revision: ref.revision });
		kinds.push("stop");
	}
	for (const e of output.tendencies) {
		const evidence = e.evidenceRefs
			.map(state)
			.filter((s): s is MemoryRef => s !== undefined)
			.map((s) => ({ namespace: "state" as const, id: s.id }));
		const target = e.ref ? context.refs[e.ref] : undefined;
		if (e.op === "add")
			items.push({ op: "tendency_add", text: e.text!, evidence });
		else if (target?.namespace === "tendency" && e.op === "update")
			items.push({
				op: "tendency_update",
				tendencyId: target.id,
				revision: target.revision,
				text: e.text!,
				evidence,
			});
		else if (target?.namespace === "tendency" && e.op === "retire")
			items.push({
				op: "tendency_retire",
				tendencyId: target.id,
				revision: target.revision,
			});
		else continue;
		kinds.push(`tendency_${e.op}`);
	}
	return { items, kinds };
}

function applyConsolidate(
	env: StepEnv,
	prepared: PreparedUnit,
	raw: unknown,
): ApplyResult {
	const output = raw as ConsolidateOutput;
	const { items, kinds } = planConsolidate(
		prepared.context as ConsolidateContext,
		output,
	);
	const results: CurationResult[] =
		items.length === 0
			? []
			: env.deps.memory.applyCurationInTransaction(env.db, {
					conversationId: env.conversationId,
					items,
				});
	const refs: ApplyResult["refs"] = [];
	let applied = 0;
	let changed = false;
	const described = results.map((result, i) => {
		if (result.status === "applied") {
			applied++;
			if (result.changed) changed = true;
			if (result.id) refs.push({ type: "item", id: result.id });
			for (const id of result.stoppedIds) refs.push({ type: "item", id });
			return { op: kinds[i], status: "applied", changed: result.changed };
		}
		return { op: kinds[i], status: "rejected", code: result.reason };
	});
	const total =
		output.merge.length + output.stop.length + output.tendencies.length;
	return {
		applied,
		rejected: output.dropped + (total - applied),
		output,
		results: described,
		refs,
		notices: [],
		changed: false,
		quiet: !changed,
		...(changed && output.republishLongTerm ? { republishLongTerm: true } : {}),
	};
}

export const consolidateMemory: StepDefinition = {
	id: "consolidate-memory" satisfies StepId,
	slot: "maintenance",
	longTerm: true,
	instructions: consolidateInstructions,
	outputSchema: () => consolidateSchema,
	prepare: (env) => prepareConsolidate(env),
	parse: parseConsolidate,
	apply: (env, prepared, output) => applyConsolidate(env, prepared, output),
};

// ---- summary upkeep (compact-history, refine-summary) ----

type SummaryContext = {
	exchanges: Record<string, string>;
	labels: string[];
	messageIds: string[];
};
type CompactOutput = { fold: string[]; summary: string; changed: boolean };

function prepareCompact(env: StepEnv) {
	if (!eligible(env, "compact-history"))
		return { status: "stale" as const, reason: "nothing_to_do" };
	const { db, deps, conversationId } = env;
	const rows = deps.memory
		.exchangesInTransaction(db, conversationId)
		.filter((row) => row.disposition === "keep");
	const loaded: LoadedExchange[] = [];
	for (const row of rows) {
		const result = loadExchange(env, row);
		if (result.status === "ok") loaded.push(result.exchange);
	}
	const { fit } = fitExchanges(loaded);
	if (fit.length === 0)
		return { status: "stale" as const, reason: "nothing_to_do" };
	const { table, views, labels: names } = labelExchanges(fit);
	const summary = deps.memory.summaryInTransaction(db, conversationId);
	const context: SummaryContext = {
		exchanges: Object.fromEntries(
			names.map((n) => [n, table[n]!.inputMessageId]),
		),
		labels: names,
		messageIds: allMessageIds(table),
	};
	return {
		status: "ready" as const,
		data: { previousSummary: summary?.text ?? "", exchanges: views },
		targets: { exchanges: fit.map((e) => e.inputMessageId) },
		summaryRevision: summary?.revision ?? 0,
		context,
	};
}

function summaryApply(
	env: StepEnv,
	prepared: PreparedUnit,
	input: {
		summary: string;
		changed: boolean;
		included: string[];
		refs: ApplyResult["refs"];
		output: unknown;
	},
): ApplyResult {
	const base = {
		output: input.output,
		refs: input.refs,
		notices: [],
		changed: false,
	};
	if (!input.changed)
		return {
			...base,
			applied: 0,
			rejected: 0,
			results: [{ status: "unchanged" }],
			quiet: true,
		};
	const written = env.deps.memory.writeSummaryInTransaction(env.db, {
		conversationId: env.conversationId,
		text: input.summary,
		included: input.included,
		expectedRevision: prepared.summaryRevision ?? 0,
	});
	if (written.ok)
		return {
			...base,
			refs: withSummarySources(base.refs, written.sources),
			applied: 1,
			rejected: 0,
			results: [
				{
					status: "applied",
					revision: written.revision,
					folded: written.included.length,
				},
			],
		};
	if (written.reason === "stale_revision")
		return {
			...base,
			applied: 0,
			rejected: 1,
			results: [],
			stale: "stale_summary",
		};
	return {
		...base,
		applied: 0,
		rejected: 1,
		results: [{ status: "rejected", code: written.reason }],
		quiet: true,
	};
}

export const compactHistory: StepDefinition = {
	id: "compact-history" satisfies StepId,
	slot: "maintenance",
	longTerm: false,
	instructions: compactInstructions,
	outputSchema: () => compactSchema,
	prepare: (env) => prepareCompact(env),
	parse(raw): CompactOutput | null {
		if (!isRecord(raw)) return null;
		const summary = text(raw.summary, SUMMARY_CHARS);
		return summary || raw.changed !== true
			? {
					fold: labels(raw.fold, 8),
					summary: summary ?? "",
					changed: raw.changed === true,
				}
			: null;
	},
	apply(env, prepared, raw) {
		const output = raw as CompactOutput;
		const context = prepared.context as SummaryContext;
		const included = output.fold
			.filter((label) => context.labels.includes(label))
			.map((label) => context.exchanges[label]!);
		const refs = context.messageIds.map((id) => ({
			type: "message" as const,
			id,
		}));
		return summaryApply(env, prepared, {
			summary: output.summary,
			changed: output.changed && included.length > 0,
			included,
			refs,
			output,
		});
	},
};

function prepareRefine(env: StepEnv) {
	if (!eligible(env, "refine-summary"))
		return { status: "stale" as const, reason: "nothing_to_do" };
	const summary = env.deps.memory.summaryInTransaction(
		env.db,
		env.conversationId,
	)!;
	return {
		status: "ready" as const,
		data: { summary: summary.text },
		targets: {},
		summaryRevision: summary.revision,
		context: { sources: summary.sources },
	};
}

export const refineSummary: StepDefinition = {
	id: "refine-summary" satisfies StepId,
	slot: "maintenance",
	longTerm: false,
	instructions: refineInstructions,
	outputSchema: () => refineSchema,
	prepare: (env) => prepareRefine(env),
	parse(raw) {
		if (!isRecord(raw)) return null;
		const summary = text(raw.summary, SUMMARY_CHARS);
		return summary ? { summary, changed: raw.changed === true } : null;
	},
	apply(env, prepared, raw) {
		const output = raw as { summary: string; changed: boolean };
		const current = env.deps.memory.summaryInTransaction(
			env.db,
			env.conversationId,
		);
		const shorter =
			current !== null && [...output.summary].length < [...current.text].length;
		const refs = (prepared.context as { sources: string[] }).sources.map(
			(id) => ({
				type: "message" as const,
				id,
			}),
		);
		return summaryApply(env, prepared, {
			summary: output.summary,
			changed: output.changed && shorter,
			included: [],
			refs,
			output,
		});
	},
};
