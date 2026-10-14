import type { ExchangeDto, ExchangeStep } from "../../../memory";
import { decisionsOfMessages } from "../../repository";
import { fitExchanges } from "../budget";
import {
	type LabelTable,
	type LoadedExchange,
	exchangeView,
	isRecord,
	loadExchange,
} from "../context";
import type { ApplyResult, StepEnv } from "../types";

/**
 * A step that can never run on an exchange is marked skipped. A skipped dispose leaves nothing to summarize, so the
 * summarize step is closed with it (the exchange then counts as done).
 */
export function skipStep(
	env: StepEnv,
	inputMessageId: string,
	step: ExchangeStep,
) {
	const { db, deps } = env;
	deps.memory.markExchangeStepInTransaction(
		db,
		inputMessageId,
		step,
		"skipped",
	);
	if (
		step === "disposed" &&
		deps.memory.exchangeInTransaction(db, inputMessageId)?.summarized === null
	)
		deps.memory.markExchangeStepInTransaction(
			db,
			inputMessageId,
			"summarized",
			"skipped",
		);
}

/**
 * The exchanges a step is about, read and fitted into its input: gone ones are marked skipped on the step
 * (they can never be read), blocked ones are left out, and what does not fit waits for the next unit.
 */
export function loadStepTargets(
	env: StepEnv,
	ids: readonly string[],
	step: ExchangeStep,
	wanted: (row: ExchangeDto) => boolean,
): LoadedExchange[] {
	const { db, deps } = env;
	const loaded: LoadedExchange[] = [];
	for (const id of ids) {
		const row = deps.memory.exchangeInTransaction(db, id);
		if (!row || !wanted(row)) continue;
		const result = loadExchange(env, row);
		if (result.status === "gone") skipStep(env, id, step);
		else if (result.status === "ok") loaded.push(result.exchange);
	}
	loaded.sort((a, b) => a.ordinal - b.ordinal);
	return fitExchanges(loaded).fit;
}

/** Labels `e1`... in chronological order; the views the model reads. */
export function labelExchanges(
	loaded: readonly LoadedExchange[],
	start = 1,
): {
	table: LabelTable;
	views: Array<Record<string, unknown>>;
	labels: string[];
} {
	const table: LabelTable = {};
	const labels: string[] = [];
	const views = loaded.map((exchange, i) => {
		const label = `e${start + i}`;
		labels.push(label);
		table[label] = {
			inputMessageId: exchange.inputMessageId,
			answerMessageId: exchange.answerMessageId,
			outcome: exchange.outcome,
		};
		return exchangeView(label, exchange);
	});
	return { table, views, labels };
}

/** What the curate step saved from these exchanges (the steps after it read it as context). */
export function curatedOf(
	env: StepEnv,
	messageIds: readonly string[],
): Array<Record<string, unknown>> {
	const out: Array<Record<string, unknown>> = [];
	for (const decision of decisionsOfMessages(
		env.db,
		env.conversationId,
		"curate-memory",
		messageIds,
		3,
	)) {
		const output = decision.output;
		if (!isRecord(output)) continue;
		for (const section of ["remember", "update"] as const) {
			const list = output[section];
			if (!Array.isArray(list)) continue;
			for (const entry of list)
				if (isRecord(entry) && typeof entry.text === "string")
					out.push({
						kind: typeof entry.kind === "string" ? entry.kind : "update",
						text: entry.text,
					});
		}
	}
	return out.slice(0, 12);
}

export function allMessageIds(table: LabelTable): string[] {
	return Object.values(table).flatMap((e) =>
		[e.inputMessageId, e.answerMessageId].filter(
			(id): id is string => id !== null,
		),
	);
}

/**
 * The decision of a step that wrote the summary refers to every message the summary now stands on (not only the
 * unit's own exchanges), so a forget of any of them finds the decision.
 */
export function withSummarySources(
	refs: ApplyResult["refs"],
	sources: readonly string[],
): ApplyResult["refs"] {
	const seen = new Set(refs.map((ref) => `${ref.type}:${ref.id}`));
	const extra = sources
		.filter((id) => !seen.has(`message:${id}`))
		.map((id) => ({ type: "message" as const, id }));
	return [...refs, ...extra];
}
