import {
	CONVERSATION_SOURCE_KIND,
	CONVERSATION_SOURCE_NAMESPACE,
} from "../../../conversation";
import type { GoalOp, GoalOpResult } from "../../../goals";
import {
	EVENTS_PER_UNIT,
	REQUESTS_PER_UNIT,
	type StepId,
} from "../../contracts";
import {
	type InboxRow,
	deleteGoalTodos,
	readInbox,
	resolveInbox,
} from "../../repository";
import { fitEvents } from "../budget";
import {
	type LabelTable,
	type LoadedEvent,
	elements,
	eventView,
	isRecord,
	labels,
	loadEvent,
	loadMessage,
	localDay,
	oneOf,
	optionalText,
	text,
} from "../context";
import { type GoalsView, describeGoals } from "../goals-view";
import { instructions } from "../prompts/curate-goals";
import { curateGoalsSchema } from "../schemas";
import type {
	ApplyResult,
	PrepareResult,
	PreparedUnit,
	StepDefinition,
	StepEnv,
} from "../types";
import { describeWorld } from "../world-view";
import { eventLabel } from "./shared";

const PRIORITIES = { high: 80, normal: 50, low: 20 } as const;
const GOAL_OPS_PER_UNIT = 8;
const GOAL_TEXT_CHARS = 500;

type GoalChange = {
	op: "propose" | "adopt" | "revise" | "complete" | "withdraw";
	ref: string | null;
	text: string | null;
	priority: keyof typeof PRIORITIES | null;
	evidence: string;
	entities: string[];
	request: string | null;
};
type CurateGoalsOutput = { goals: GoalChange[]; dropped: number };

type GoalsContext = {
	events: LabelTable;
	/** The events this unit settles (`seq`): their goal reflection is done afterwards. */
	targetSeqs: number[];
	/** `r1`... -> the inbox id of a goal request. */
	requests: Record<string, string>;
	goals: GoalsView["refs"];
	/** `w1`... -> World entity id. */
	entities: Record<string, string>;
};

function parse(raw: unknown): CurateGoalsOutput | null {
	if (!isRecord(raw)) return null;
	const read = elements<GoalChange>(
		raw.goals,
		(e) => {
			const op = oneOf(e.op, [
				"propose",
				"adopt",
				"revise",
				"complete",
				"withdraw",
			] as const);
			const evidence = text(e.evidence, 16);
			if (!op || !evidence) return null;
			return {
				op,
				ref: optionalText(e.ref, 16),
				text: optionalText(e.text, GOAL_TEXT_CHARS),
				priority: oneOf(e.priority, ["high", "normal", "low"] as const),
				evidence,
				entities: labels(e.entities, 20),
				request: optionalText(e.request, 16),
			};
		},
		GOAL_OPS_PER_UNIT,
	);
	return { goals: read.items, dropped: read.dropped };
}

/** One shown item: an event by its `seq`, a request's source message by its id. */
const keyOf = (loaded: LoadedEvent) =>
	loaded.messageId !== null ? `m:${loaded.messageId}` : `e:${loaded.seq}`;

function prepare(
	env: StepEnv,
	unit: { targets: { seqs?: number[]; requests?: string[] } },
): PrepareResult {
	const { db, deps, conversationId } = env;
	const goalsDeps = deps.goals;
	if (!goalsDeps) return { status: "stale", reason: "goals_off" };
	const now = deps.clock();
	const entries: Array<{
		loaded: LoadedEvent;
		target: boolean;
		requestIds: string[];
	}> = [];
	const byKey = new Map<string, (typeof entries)[number]>();
	const requests: InboxRow[] = [];
	for (const id of unit.targets.requests ?? []) {
		const row = readInbox(db, id);
		if (!row || row.state !== "pending") continue;
		if (row.what === "") {
			resolveInbox(db, id, "none", "forgotten", now);
			continue;
		}
		const loaded = loadMessage(env, row.sourceRef);
		if (loaded.status !== "ok") {
			resolveInbox(
				db,
				id,
				"none",
				loaded.status === "blocked" ? "source_blocked" : "source_unavailable",
				now,
			);
			continue;
		}
		requests.push(row);
		const key = keyOf(loaded.event);
		const existing = byKey.get(key);
		if (existing) existing.requestIds.push(id);
		else {
			const entry = { loaded: loaded.event, target: false, requestIds: [id] };
			entries.push(entry);
			byKey.set(key, entry);
		}
	}
	const gone: number[] = [];
	for (const seq of unit.targets.seqs ?? []) {
		const event = deps.continuity.events.eventInTransaction(
			db,
			conversationId,
			seq,
		);
		const loaded = event ? loadEvent(env, event) : null;
		if (!loaded || loaded.status !== "ok") {
			gone.push(seq);
			continue;
		}
		const key = keyOf(loaded.event);
		const existing = byKey.get(key);
		if (existing) {
			existing.loaded = loaded.event;
			existing.target = true;
		} else {
			const entry = { loaded: loaded.event, target: true, requestIds: [] };
			entries.push(entry);
			byKey.set(key, entry);
		}
	}
	// An event that can not be read any more (retracted, forgotten) has no goal reflection to wait for.
	deleteGoalTodos(db, conversationId, gone);
	const byTime = (a: (typeof entries)[number], b: (typeof entries)[number]) =>
		a.loaded.at.localeCompare(b.loaded.at) ||
		(a.loaded.seq ?? 0) - (b.loaded.seq ?? 0);
	const ordered = entries.sort(
		(a, b) =>
			(b.requestIds.length > 0 ? 1 : 0) - (a.requestIds.length > 0 ? 1 : 0) ||
			byTime(a, b),
	);
	const kept = fitEvents(
		ordered.map((entry) => ({ ...entry, bytes: entry.loaded.bytes })),
		{ maxCount: EVENTS_PER_UNIT },
	).fit.sort(byTime);
	const keptRequestIds = new Set(kept.flatMap((e) => e.requestIds));
	const requestRows = requests
		.filter((row) => keptRequestIds.has(row.id))
		.slice(0, REQUESTS_PER_UNIT);
	const targets = kept.filter((e) => e.target);
	if (targets.length === 0 && requestRows.length === 0)
		return { status: "stale", reason: "nothing_to_do" };

	const events: LabelTable = {};
	const labelOf = new Map<string, string>();
	const views = kept.map((entry, i) => {
		const label = eventLabel(entry.loaded, i);
		labelOf.set(keyOf(entry.loaded), label);
		events[label] = {
			seq: entry.loaded.seq,
			messageId: entry.loaded.messageId,
			by: entry.loaded.by,
		};
		return eventView(label, entry.loaded, !entry.target);
	});
	const requestMap: GoalsContext["requests"] = {};
	const requestViews = requestRows.map((row, i) => {
		const id = `r${i + 1}`;
		requestMap[id] = row.id;
		return {
			id,
			what: row.what,
			...(row.detail ? { detail: row.detail } : {}),
			event: labelOf.get(`m:${row.sourceRef}`) ?? "",
		};
	});
	const goals = describeGoals(env, ["adopted", "proposed"]);
	const world = describeWorld(
		env,
		kept.map((e) => e.loaded.text.text),
	);
	const entities: GoalsContext["entities"] = {};
	for (const [ref, entry] of Object.entries(world?.refs ?? {}))
		if (entry.kind === "entity") entities[ref] = entry.id;
	const context: GoalsContext = {
		events,
		targetSeqs: targets
			.map((e) => e.loaded.seq)
			.filter((seq): seq is number => seq !== null),
		requests: requestMap,
		goals: goals?.refs ?? {},
		entities,
	};
	return {
		status: "ready",
		data: {
			today: localDay(deps.nowMs()),
			events: views,
			requests: requestViews,
			goals: goals?.goals ?? [],
			worldEntities: world?.entities ?? [],
		},
		targets: {
			seqs: context.targetSeqs,
			requests: requestRows.map((r) => r.id),
		},
		context,
	};
}

function apply(
	env: StepEnv,
	prepared: PreparedUnit,
	raw: unknown,
): ApplyResult {
	const { db, deps } = env;
	const goalsDeps = deps.goals!;
	const context = prepared.context as GoalsContext;
	const output = raw as CurateGoalsOutput;
	const scopeKey = goalsDeps.access.scopeKeys[0]!;
	const results: unknown[] = [];
	const ops: GoalOp[] = [];
	const opMeta: Array<{ index: number; request: string | null }> = [];
	let rejected = output.dropped;
	const reject = (index: number, code: string) => {
		rejected++;
		results.push({ index, status: "rejected", code });
	};
	output.goals.forEach((change, index) => {
		// Only a user's own words are evidence of a goal.
		const evidence = context.events[change.evidence];
		if (evidence?.by !== "user" || evidence.messageId === null)
			return reject(index, "unknown_evidence");
		const messageId = evidence.messageId;
		const link = {
			source: {
				namespace: CONVERSATION_SOURCE_NAMESPACE,
				kind: CONVERSATION_SOURCE_KIND,
				id: messageId,
			},
			sourceMessageIds: [messageId],
			entityIds: [
				...new Set(
					change.entities
						.map((ref) => context.entities[ref])
						.filter((id): id is string => id !== undefined),
				),
			],
		};
		const priority = change.priority ? PRIORITIES[change.priority] : undefined;
		const target = change.ref ? context.goals[change.ref] : undefined;
		const operationKey = `${prepared.unit.id}:${index}`;
		let op: GoalOp;
		if (change.op === "propose" || (change.op === "adopt" && !change.ref)) {
			if (!change.text) return reject(index, "invalid_input");
			const fresh = {
				scopeKey,
				desiredState: change.text,
				...(priority === undefined ? {} : { priority }),
				...link,
				operationKey,
			};
			op =
				change.op === "propose"
					? { op: "propose", ...fresh }
					: { op: "adopt", ...fresh };
		} else {
			if (!target) return reject(index, "unknown_ref");
			if (change.op === "adopt") {
				if (target.status !== "proposed") return reject(index, "goal_state");
				op = {
					op: "adopt",
					goalId: target.goalId,
					expectedRevision: target.revision,
					...(change.text ? { desiredState: change.text } : {}),
					...(priority === undefined ? {} : { priority }),
					...link,
				};
			} else if (change.op === "revise") {
				if (target.status !== "adopted") return reject(index, "goal_state");
				if (!change.text && priority === undefined)
					return reject(index, "invalid_input");
				op = {
					op: "revise",
					goalId: target.goalId,
					expectedRevision: target.revision,
					...(change.text ? { desiredState: change.text } : {}),
					...(priority === undefined ? {} : { priority }),
					...link,
				};
			} else {
				// complete / withdraw
				if (change.op === "complete" && target.status !== "adopted")
					return reject(index, "goal_state");
				if (target.status !== "adopted" && target.status !== "proposed")
					return reject(index, "goal_state");
				op = {
					op: change.op as "complete" | "withdraw",
					goalId: target.goalId,
					expectedRevision: target.revision,
					...link,
				};
			}
		}
		ops.push(op);
		opMeta.push({ index, request: change.request });
	});
	const outcomes: GoalOpResult[] =
		ops.length === 0
			? []
			: goalsDeps.ops.applyInTransaction(db, goalsDeps.access, ops);
	const refs: ApplyResult["refs"] = [];
	let applied = 0;
	const answered = new Set<string>();
	outcomes.forEach((outcome, i) => {
		const meta = opMeta[i]!;
		if (outcome.status === "applied") {
			applied++;
			refs.push({ type: "goal", id: outcome.goal.id });
			if (meta.request) answered.add(meta.request);
			results.push({
				index: meta.index,
				status: "applied",
				goalId: outcome.goal.id,
				goalStatus: outcome.goal.status,
				...(outcome.replayed ? { replayed: true } : {}),
			});
		} else reject(meta.index, outcome.reason);
	});

	const notices = new Set<string>();
	const now = deps.clock();
	for (const [label, id] of Object.entries(context.requests)) {
		refs.push({ type: "request", id });
		const done = answered.has(label);
		resolveInbox(
			db,
			id,
			done ? "done" : "none",
			done ? null : "no_goal_change",
			now,
		);
		notices.add(
			done
				? "目標の依頼を反映しました。"
				: "目標の依頼で変えるものはありませんでした。",
		);
	}
	deleteGoalTodos(db, env.conversationId, context.targetSeqs);
	for (const event of Object.values(context.events))
		if (event.messageId !== null)
			refs.push({ type: "message", id: event.messageId });
	return {
		applied,
		rejected,
		output,
		results,
		refs,
		notices: [...notices],
		changed: applied > 0,
	};
}

export const curateGoals: StepDefinition = {
	id: "curate-goals" satisfies StepId,
	slot: "reflect",
	// Goals are one shelf for the whole Scope: written one unit at a time, like the long-term memory.
	longTerm: true,
	instructions,
	outputSchema: () => curateGoalsSchema,
	prepare: (env, unit) => prepare(env, unit),
	parse,
	apply: (env, prepared, output) => apply(env, prepared, output),
};
