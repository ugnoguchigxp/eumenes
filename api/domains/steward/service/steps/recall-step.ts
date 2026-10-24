import type { StepId } from "../../contracts";
import type { UnitTargets } from "../../repository";
import {
	type LabelTable,
	type LoadedEvent,
	isRecord,
	loadEvent,
	localDay,
	optionalText,
} from "../context";
import { instructions as recallInstructions } from "../prompts/prepare-recall";
import { recallSchema } from "../schemas";
import type { ApplyResult, StepDefinition, StepEnv } from "../types";
import { labelEvents, messageRefs } from "./shared";

const RECALL_QUERY_CHARS = 200;
/** The last said events (the user's and the agent's words) the recall preparation reads. */
const RECALL_EVENTS = 4;

type RecallOutput = { query: string | null };
type RecallVector = Awaited<
	ReturnType<StepEnv["deps"]["memory"]["vectors"]["embedQuery"]>
>;
type RecallContext = { events: LabelTable };

function prepareRecall(env: StepEnv, unit: { targets: UnitTargets }) {
	const { db, deps, conversationId } = env;
	const last = unit.targets.recallSeq;
	if (last === undefined)
		return { status: "stale" as const, reason: "nothing_to_do" };
	const loaded: LoadedEvent[] = [];
	const log = deps.continuity.events
		.logInTransaction(db, conversationId)
		.filter((event) => event.type === "said" && event.seq <= last)
		.sort((a, b) => a.seq - b.seq)
		.slice(-RECALL_EVENTS);
	for (const event of log) {
		const result = loadEvent(env, event);
		if (result.status === "ok") loaded.push(result.event);
	}
	if (loaded.length === 0)
		return { status: "stale" as const, reason: "nothing_to_do" };
	const { table, views } = labelEvents(loaded);
	const episode = deps.continuity.events
		.episodeInTransaction(db, conversationId, "shown")
		.filter((part) => part.kind === "summary")
		.map((part) => ({ from: part.fromAt, to: part.toAt, text: part.text }));
	return {
		status: "ready" as const,
		data: { today: localDay(deps.nowMs()), episode, events: views },
		targets: { recallSeq: last },
		windowVersion: null,
		context: { events: table } satisfies RecallContext,
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
		const context = prepared.context as RecallContext;
		const query = (output as RecallOutput).query;
		const prefetch = query
			? env.deps.memory.vectors.prefetchOf(
					env.db,
					env.conversationId,
					extras as RecallVector,
					env.deps.memory.windowPlan().sections.now,
				)
			: { text: "", pins: [], tokens: 0 };
		return {
			applied: prefetch ? 1 : 0,
			rejected: 0,
			output,
			results: [{ prefetched: prefetch ? prefetch.pins.length : null }],
			refs: messageRefs(
				Object.values(context.events)
					.map((e) => e.messageId)
					.filter((id): id is string => id !== null),
			),
			notices: [],
			changed: false,
			...(prefetch ? { prefetch } : {}),
		};
	},
};
