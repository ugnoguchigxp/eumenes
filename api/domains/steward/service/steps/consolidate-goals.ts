import {
	CONVERSATION_SOURCE_KIND,
	CONVERSATION_SOURCE_NAMESPACE,
} from "../../../conversation";
import {
	MAX_PROPOSED_GOALS,
	type GoalOp,
	type GoalOpResult,
} from "../../../goals";
import type { StepId } from "../../contracts";
import { clipChars } from "../budget";
import { elements, isRecord, localDay, oneOf, text } from "../context";
import { instructions } from "../prompts/consolidate-goals";
import { consolidateGoalsSchema } from "../schemas";
import type {
	ApplyResult,
	PrepareResult,
	PreparedUnit,
	StepDefinition,
	StepEnv,
} from "../types";

const WITHDRAWALS_PER_UNIT = 10;
const TEXT_CHARS = 200;

type Output = {
	withdraw: Array<{
		ref: string;
		why: "duplicate" | "stale" | "low_relevance";
	}>;
	changed: boolean;
	dropped: number;
};
type Context = {
	/** `g1`... -> a proposal and the message that proposed it. */
	proposals: Record<
		string,
		{ goalId: string; revision: number; messageId: string }
	>;
};

/** The proposals of the goals, with the conversation message each stands on (a withdrawal cites it). */
function proposalsOf(env: StepEnv) {
	const goals = env.deps.goals;
	if (!goals) return [];
	return goals.ops
		.proposalsInTransaction(env.db, goals.access)
		.filter(
			(goal) =>
				goal.source.namespace === CONVERSATION_SOURCE_NAMESPACE &&
				goal.source.kind === CONVERSATION_SOURCE_KIND,
		);
}

/** Two proposals can overlap; fewer can not. */
export const goalsEligible = (env: StepEnv): boolean =>
	proposalsOf(env).length >= 2;

function prepare(env: StepEnv): PrepareResult {
	const goals = env.deps.goals!;
	const proposals = proposalsOf(env);
	if (proposals.length < 2) return { status: "stale", reason: "nothing_to_do" };
	const adopted = goals.ops
		.listForStewardInTransaction(env.db, goals.access, ["adopted"])
		.sort((a, b) => b.priority - a.priority);
	const context: Context = { proposals: {} };
	const shown = proposals.map((goal, i) => {
		const ref = `g${i + 1}`;
		context.proposals[ref] = {
			goalId: goal.id,
			revision: goal.revision,
			messageId: goal.source.id,
		};
		return {
			ref,
			text: clipChars(goal.desiredState, TEXT_CHARS),
			priority: goal.priority,
			updated: goal.updatedAt.slice(0, 10),
		};
	});
	return {
		status: "ready",
		data: {
			today: localDay(env.deps.nowMs()),
			limit: MAX_PROPOSED_GOALS,
			count: proposals.length,
			proposals: shown,
			adopted: adopted.map((goal) => clipChars(goal.desiredState, TEXT_CHARS)),
		},
		targets: {},
		windowVersion: null,
		context,
	};
}

function parse(raw: unknown): Output | null {
	if (!isRecord(raw)) return null;
	const read = elements(
		raw.withdraw,
		(e) => {
			const ref = text(e.ref, 16);
			const why = oneOf(e.why, [
				"duplicate",
				"stale",
				"low_relevance",
			] as const);
			return ref && why ? { ref, why } : null;
		},
		WITHDRAWALS_PER_UNIT,
	);
	return {
		withdraw: read.items,
		changed: raw.changed === true,
		dropped: read.dropped,
	};
}

function apply(
	env: StepEnv,
	prepared: PreparedUnit,
	raw: unknown,
): ApplyResult {
	const { db, deps } = env;
	const goals = deps.goals!;
	const output = raw as Output;
	const context = prepared.context as Context;
	const ops: GoalOp[] = [];
	const meta: Array<{ ref: string; why: string }> = [];
	const results: unknown[] = [];
	let rejected = output.dropped;
	const seen = new Set<string>();
	for (const entry of output.withdraw) {
		// Only proposals the model was shown can be withdrawn here: an adopted goal has no ref in this step.
		const target = context.proposals[entry.ref];
		if (!target || seen.has(entry.ref)) {
			rejected++;
			results.push({ ref: entry.ref, status: "rejected", code: "unknown_ref" });
			continue;
		}
		seen.add(entry.ref);
		ops.push({
			op: "withdraw",
			goalId: target.goalId,
			expectedRevision: target.revision,
			source: {
				namespace: CONVERSATION_SOURCE_NAMESPACE,
				kind: CONVERSATION_SOURCE_KIND,
				id: target.messageId,
			},
			sourceMessageIds: [target.messageId],
			entityIds: [],
		});
		meta.push(entry);
	}
	const outcomes: GoalOpResult[] =
		ops.length === 0 ? [] : goals.ops.applyInTransaction(db, goals.access, ops);
	const refs: ApplyResult["refs"] = [];
	let applied = 0;
	outcomes.forEach((outcome, i) => {
		const entry = meta[i]!;
		if (outcome.status === "applied") {
			applied++;
			refs.push(
				{ type: "goal", id: outcome.goal.id },
				{ type: "message", id: context.proposals[entry.ref]!.messageId },
			);
			results.push({ ref: entry.ref, why: entry.why, status: "applied" });
		} else {
			rejected++;
			results.push({
				ref: entry.ref,
				status: "rejected",
				code: outcome.reason,
			});
		}
	});
	return {
		applied,
		rejected,
		output,
		results,
		refs,
		notices: [],
		changed: false,
		quiet: applied === 0,
	};
}

export const consolidateGoals: StepDefinition = {
	id: "consolidate-goals" satisfies StepId,
	slot: "maintenance",
	longTerm: true,
	instructions,
	outputSchema: () => consolidateGoalsSchema,
	prepare: (env) => prepare(env),
	parse,
	apply: (env, prepared, output) => apply(env, prepared, output),
};
