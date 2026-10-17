import type { Disposition } from "../../../memory";
import type { StepId } from "../../contracts";
import { clipChars } from "../budget";
import {
	type LabelTable,
	type LoadedExchange,
	elements,
	isRecord,
	labels,
	loadExchange,
	localDay,
	oneOf,
	optionalText,
	text,
} from "../context";
import { instructions as disposeInstructions } from "../prompts/dispose-exchanges";
import { instructions as recallInstructions } from "../prompts/prepare-recall";
import { instructions as summarizeInstructions } from "../prompts/summarize";
import { disposeSchema, recallSchema, summarizeSchema } from "../schemas";
import type {
	ApplyResult,
	PreparedUnit,
	StepDefinition,
	StepEnv,
} from "../types";
import {
	allMessageIds,
	curatedOf,
	labelExchanges,
	loadStepTargets,
	withSummarySources,
} from "./shared";

const SUMMARY_CHARS = 1200;
const KEEP_LIST = 30;
const KEEP_PREVIEW_CHARS = 100;
const RECALL_QUERY_CHARS = 200;

type ExchangeContext = {
	exchanges: LabelTable;
	/** Labels of the exchanges this unit settles (the rest are context). */
	targets: string[];
	ordinals: Record<string, number>;
};
const messagesOf = (context: ExchangeContext) =>
	allMessageIds(context.exchanges);
const refsOf = (context: ExchangeContext): ApplyResult["refs"] =>
	messagesOf(context).map((id) => ({ type: "message", id }));

// ---- dispose-exchanges ----

type DisposeOutput = {
	exchanges: Array<{
		id: string;
		action: Disposition;
		duplicateOf: string | null;
	}>;
	dropped: number;
};
function parseDispose(raw: unknown): DisposeOutput | null {
	if (!isRecord(raw) || !Array.isArray(raw.exchanges)) return null;
	const read = elements(
		raw.exchanges,
		(e) => {
			const id = text(e.id, 16);
			const action = oneOf(e.action, ["keep", "summarize", "drop"] as const);
			return id && action
				? { id, action, duplicateOf: optionalText(e.duplicateOf, 16) }
				: null;
		},
		64,
	);
	return { exchanges: read.items, dropped: read.dropped };
}

function prepareDispose(
	env: StepEnv,
	unit: { targets: { exchanges?: string[] | undefined } },
) {
	const { db, deps, conversationId } = env;
	const loaded = loadStepTargets(
		env,
		unit.targets.exchanges ?? [],
		"disposed",
		(row) => row.disposed === null,
	);
	if (loaded.length === 0)
		return { status: "stale" as const, reason: "nothing_to_do" };
	const targetIds = new Set(loaded.map((e) => e.inputMessageId));
	const { table, views, labels: targetLabels } = labelExchanges(loaded);
	const ordinals: Record<string, number> = {};
	for (const e of loaded) ordinals[e.inputMessageId] = e.ordinal;
	const keepRows = deps.memory
		.exchangesInTransaction(db, conversationId)
		.filter(
			(row) => row.disposition === "keep" && !targetIds.has(row.inputMessageId),
		)
		.slice(-KEEP_LIST);
	const blocked = deps.memory.blockedMessageIdsInTransaction(
		db,
		keepRows.flatMap((r) => [
			r.inputMessageId,
			...(r.answerMessageId ? [r.answerMessageId] : []),
		]),
	);
	const keepList: Array<Record<string, unknown>> = [];
	for (const row of keepRows) {
		if (
			blocked.has(row.inputMessageId) ||
			(row.answerMessageId && blocked.has(row.answerMessageId))
		)
			continue;
		const user = deps.conversation.messageInTransaction(db, row.inputMessageId);
		if (!user) continue;
		const label = `e${loaded.length + keepList.length + 1}`;
		table[label] = {
			inputMessageId: row.inputMessageId,
			answerMessageId: row.answerMessageId,
			outcome: row.outcome,
		};
		ordinals[row.inputMessageId] = row.inputOrdinal;
		keepList.push({
			id: label,
			at: user.message.createdAt,
			preview: clipChars(user.message.text, KEEP_PREVIEW_CHARS),
		});
	}
	const context: ExchangeContext = {
		exchanges: table,
		targets: targetLabels,
		ordinals,
	};
	return {
		status: "ready" as const,
		data: {
			exchanges: views,
			keepList,
			curated: curatedOf(env, [...targetIds]),
		},
		targets: { exchanges: [...targetIds] },
		summaryRevision: null,
		context,
	};
}

function applyDispose(
	env: StepEnv,
	prepared: PreparedUnit,
	raw: unknown,
): ApplyResult {
	const { db, deps } = env;
	const context = prepared.context as ExchangeContext;
	const output = raw as DisposeOutput;
	const results: unknown[] = [];
	let applied = 0;
	let rejected = output.dropped;
	// Only a verdict that adds to the history or the summary gives the upkeep something new to look at.
	let grew = false;
	const seen = new Set<string>();
	for (const e of output.exchanges) {
		const target = context.exchanges[e.id];
		if (!context.targets.includes(e.id) || !target || seen.has(e.id)) {
			rejected++;
			results.push({ id: e.id, status: "rejected", code: "unknown_exchange" });
			continue;
		}
		seen.add(e.id);
		let action = e.action;
		let duplicate = e.duplicateOf
			? context.exchanges[e.duplicateOf]
			: undefined;
		if (duplicate?.inputMessageId === target.inputMessageId)
			duplicate = undefined;
		if (duplicate) {
			const olderIsDuplicate =
				(context.ordinals[duplicate.inputMessageId] ?? 0) <
				(context.ordinals[target.inputMessageId] ?? 0);
			// The older of the two repeats leaves the verbatim history.
			if (olderIsDuplicate)
				deps.memory.setDispositionInTransaction(
					db,
					duplicate.inputMessageId,
					"drop",
					null,
				);
			else action = "drop";
		}
		deps.memory.setDispositionInTransaction(
			db,
			target.inputMessageId,
			action,
			duplicate?.inputMessageId ?? null,
		);
		deps.memory.markExchangeStepInTransaction(
			db,
			target.inputMessageId,
			"disposed",
			"done",
		);
		applied++;
		if (action !== "drop") grew = true;
		results.push({
			id: e.id,
			status: "applied",
			action,
			duplicate: duplicate !== undefined,
		});
	}
	return {
		applied,
		rejected,
		output,
		results,
		refs: refsOf(context),
		notices: [],
		changed: grew,
		unusable: applied === 0,
	};
}

export const disposeExchanges: StepDefinition = {
	id: "dispose-exchanges" satisfies StepId,
	slot: "reflect",
	longTerm: false,
	instructions: disposeInstructions,
	outputSchema: () => disposeSchema,
	prepare: (env, unit) => prepareDispose(env, unit),
	parse: parseDispose,
	apply: applyDispose,
};

// ---- summarize ----

type SummarizeOutput = { summary: string; included: string[] };
function parseSummarize(raw: unknown): SummarizeOutput | null {
	if (!isRecord(raw)) return null;
	const summary = text(raw.summary, SUMMARY_CHARS);
	return summary ? { summary, included: labels(raw.included, 8) } : null;
}
function summaryOf(env: StepEnv): { text: string; revision: number } {
	const summary = env.deps.memory.summaryInTransaction(
		env.db,
		env.conversationId,
	);
	return { text: summary?.text ?? "", revision: summary?.revision ?? 0 };
}

function prepareSummarize(
	env: StepEnv,
	unit: { targets: { exchanges?: string[] | undefined } },
) {
	const loaded = loadStepTargets(
		env,
		unit.targets.exchanges ?? [],
		"summarized",
		(row) => row.summarized === null && row.disposition === "summarize",
	);
	if (loaded.length === 0)
		return { status: "stale" as const, reason: "nothing_to_do" };
	const { table, views, labels: targetLabels } = labelExchanges(loaded);
	const previous = summaryOf(env);
	const context: ExchangeContext = {
		exchanges: table,
		targets: targetLabels,
		ordinals: {},
	};
	return {
		status: "ready" as const,
		data: {
			previousSummary: previous.text,
			exchanges: views,
			curated: curatedOf(
				env,
				loaded.map((e) => e.inputMessageId),
			),
		},
		targets: { exchanges: loaded.map((e) => e.inputMessageId) },
		summaryRevision: previous.revision,
		context,
	};
}

function applySummarize(
	env: StepEnv,
	prepared: PreparedUnit,
	raw: unknown,
): ApplyResult {
	const context = prepared.context as ExchangeContext;
	const output = raw as SummarizeOutput;
	const included = output.included
		.filter((label) => context.targets.includes(label))
		.map((label) => context.exchanges[label]!.inputMessageId);
	const base = { notices: [], refs: refsOf(context), output, changed: false };
	if (included.length === 0)
		return {
			...base,
			applied: 0,
			rejected: 1,
			results: [{ status: "rejected", code: "nothing_included" }],
			unusable: true,
		};
	const written = env.deps.memory.writeSummaryInTransaction(env.db, {
		conversationId: env.conversationId,
		text: output.summary,
		included,
		expectedRevision: prepared.summaryRevision ?? 0,
	});
	if (!written.ok) {
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
			unusable: true,
		};
	}
	return {
		...base,
		refs: withSummarySources(base.refs, written.sources),
		applied: written.included.length,
		rejected: included.length - written.included.length,
		results: [
			{
				status: "applied",
				revision: written.revision,
				included: written.included.length,
			},
		],
		changed: true,
	};
}

export const summarize: StepDefinition = {
	id: "summarize" satisfies StepId,
	slot: "reflect",
	longTerm: false,
	instructions: summarizeInstructions,
	outputSchema: () => summarizeSchema,
	prepare: (env, unit) => prepareSummarize(env, unit),
	parse: parseSummarize,
	apply: applySummarize,
};

// ---- prepare-recall ----

type RecallOutput = { query: string | null };
type RecallVector = Awaited<
	ReturnType<StepEnv["deps"]["memory"]["vectors"]["embedQuery"]>
>;

function prepareRecall(
	env: StepEnv,
	unit: { targets: { message?: string | undefined } },
) {
	const { db, deps, conversationId } = env;
	const target = unit.targets.message
		? deps.memory.exchangeInTransaction(db, unit.targets.message)
		: null;
	if (!target) return { status: "stale" as const, reason: "nothing_to_do" };
	const recent = deps.memory
		.exchangesInTransaction(db, conversationId)
		.filter((row) => row.inputOrdinal <= target.inputOrdinal)
		.slice(-2);
	const loaded: LoadedExchange[] = [];
	for (const row of recent) {
		const result = loadExchange(env, row);
		if (result.status === "ok") loaded.push(result.exchange);
	}
	if (loaded.length === 0)
		return { status: "stale" as const, reason: "nothing_to_do" };
	const { table, views } = labelExchanges(loaded);
	const summary = summaryOf(env);
	const context: ExchangeContext = {
		exchanges: table,
		targets: [],
		ordinals: {},
	};
	return {
		status: "ready" as const,
		data: {
			today: localDay(deps.nowMs()),
			summary: summary.text,
			exchanges: views,
		},
		targets: { message: unit.targets.message },
		summaryRevision: summary.revision,
		context,
	};
}

export const prepareRecallStep: StepDefinition = {
	id: "prepare-recall" satisfies StepId,
	slot: "recall",
	longTerm: false,
	instructions: recallInstructions,
	outputSchema: () => recallSchema,
	prepare: (env, unit) => prepareRecall(env, unit),
	parse: (raw): RecallOutput | null =>
		isRecord(raw)
			? { query: optionalText(raw.query, RECALL_QUERY_CHARS) }
			: null,
	afterInfer: async (_prepared, output, _extras, ctx) => {
		const query = (output as RecallOutput).query;
		return query
			? await ctx.deps.memory.vectors.embedQuery(query, ctx.signal)
			: null;
	},
	apply(env, prepared, output, extras): ApplyResult {
		const context = prepared.context as ExchangeContext;
		const query = (output as RecallOutput).query;
		const prefetch = query
			? env.deps.memory.vectors.prefetchOf(
					env.db,
					env.conversationId,
					extras as RecallVector,
				)
			: { text: "", pins: [], tokens: 0 };
		return {
			applied: prefetch ? 1 : 0,
			rejected: 0,
			output,
			results: [{ prefetched: prefetch ? prefetch.pins.length : null }],
			refs: refsOf(context),
			notices: [],
			changed: false,
			...(prefetch ? { prefetch } : {}),
		};
	},
};
