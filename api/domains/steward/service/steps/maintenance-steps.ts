import type { CurationItem, CurationResult } from "../../../memory";
import type { StepId } from "../../contracts";
import {
	type MemoryRef,
	activeStateItems,
	describeMemory,
	elements,
	isRecord,
	labels,
	localDay,
	oneOf,
	optionalText,
	text,
} from "../context";
import { instructions as consolidateInstructions } from "../prompts/consolidate-memory";
import { consolidateSchema } from "../schemas";
import type {
	ApplyResult,
	PreparedUnit,
	StepDefinition,
	StepEnv,
} from "../types";
import { goalsEligible } from "./consolidate-goals";

// ---- eligibility (the kick asks before it makes a unit) ----

/** Whether the step has anything to look at now (a quiet step is not asked again until the revision moves). */
export function eligible(env: StepEnv, step: StepId): boolean {
	switch (step) {
		case "consolidate-memory":
			return activeStateItems(env).length >= 2;
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
		...(changed && output.republishLongTerm ? { requestRepublish: true } : {}),
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
