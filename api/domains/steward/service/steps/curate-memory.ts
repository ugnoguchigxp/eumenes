import { RECALL_MIN_SCORE } from "../../../memory";
import { type RequestKind, type StepId } from "../../contracts";
import {
	type InboxRow,
	readInbox,
	resolveInbox,
	type UnitTargets,
} from "../../repository";
import { clipChars, fitEvents } from "../budget";
import {
	type LabelTable,
	type LoadedEvent,
	describeMemory,
	eventView,
	loadMessage,
	localDay,
} from "../context";
import { describeGoals } from "../goals-view";
import { instructions } from "../prompts/curate-memory";
import { curateSchema } from "../schemas";
import { describeWorld } from "../world-view";
import type {
	ExecuteContext,
	PreparedUnit,
	StepDefinition,
	StepEnv,
} from "../types";
import { applyCurate } from "./curate-apply";
import { eventLabel } from "./shared";
import {
	CANDIDATES_PER_REQUEST,
	CANDIDATES_TOTAL,
	CANDIDATE_CHARS,
	FORGET_SEARCHES,
	type Candidates,
	type CurateContext,
	type CurateExtras,
	parseCurate,
} from "./curate-types";

// ---- prepare ----

/** A request's source message, shown to the model as the context the request was made in. */
type Entry = {
	loaded: LoadedEvent;
	requestIds: string[];
	bytes: number;
};
/** One shown item: a request's source message by its id. */
const keyOf = (loaded: LoadedEvent) =>
	loaded.messageId !== null ? `m:${loaded.messageId}` : `e:${loaded.seq}`;
const orderOf = (a: Entry, b: Entry) =>
	a.loaded.at.localeCompare(b.loaded.at) ||
	(a.loaded.seq ?? 0) - (b.loaded.seq ?? 0);

function prepare(env: StepEnv, unit: { targets: UnitTargets }) {
	const { db } = env;
	const entries = new Map<string, Entry>();
	const dropRequest: Array<{ id: string; code: string }> = [];
	const requests: InboxRow[] = [];
	for (const id of unit.targets.requests ?? []) {
		const row = readInbox(db, id);
		if (!row || row.state !== "pending") continue;
		if (row.what === "") {
			dropRequest.push({ id, code: "forgotten" });
			continue;
		}
		const loaded = loadMessage(env, row.sourceRef);
		if (loaded.status !== "ok") {
			dropRequest.push({
				id,
				code:
					loaded.status === "blocked" ? "source_blocked" : "source_unavailable",
			});
			continue;
		}
		requests.push(row);
		const key = keyOf(loaded.event);
		const existing = entries.get(key);
		if (existing) existing.requestIds.push(id);
		else
			entries.set(key, {
				loaded: loaded.event,
				requestIds: [id],
				bytes: loaded.event.bytes,
			});
	}
	return { entries, requests, dropRequest };
}

function buildPrepared(env: StepEnv, unit: PreparedUnit["unit"]) {
	const { db } = env;
	const found = prepare(env, unit);
	const now = env.deps.clock();
	for (const { id, code } of found.dropRequest)
		resolveInbox(db, id, "none", code, now);
	const { fit } = fitEvents([...found.entries.values()].sort(orderOf));
	const kept = fit.sort(orderOf);
	const keptRequestIds = new Set(kept.flatMap((e) => e.requestIds));
	const requestRows = found.requests.filter((r) => keptRequestIds.has(r.id));
	if (requestRows.length === 0) return null;
	return { kept, requestRows };
}

/**
 * World's claims and entities and the goals, as refs a forget request may name (F3, F4, F8). Shown only when the unit
 * holds a forget request: they cost tokens and nothing else of this step uses them.
 */
function describeShelves(
	env: StepEnv,
	requestRows: readonly InboxRow[],
	kept: ReadonlyArray<{ loaded: LoadedEvent }>,
): {
	refs: CurateContext["refs"];
	shown: CurateContext["shown"];
	claimEntities: CurateContext["claimEntities"];
	data: Record<string, unknown>;
} {
	const refs: CurateContext["refs"] = {};
	const shown: CurateContext["shown"] = {};
	const claimEntities: CurateContext["claimEntities"] = {};
	const data: Record<string, unknown> = {};
	const forgets = requestRows.filter((row) => row.kind === "forget");
	if (forgets.length === 0) return { refs, shown, claimEntities, data };
	const world = describeWorld(env, [
		...forgets.map((row) => row.what),
		...kept.map((e) => e.loaded.text.text),
	]);
	if (world && (world.entities.length > 0 || world.claims.length > 0)) {
		for (const [ref, entry] of Object.entries(world.refs))
			refs[ref] = { namespace: entry.kind, id: entry.id, revision: 0 };
		for (const entity of world.entities)
			shown[entity.ref] = [entity.name, ...entity.aliases];
		for (const claim of world.claims) shown[claim.ref] = [claim.text];
		for (const [ref, entry] of Object.entries(world.refs))
			if (entry.kind === "claim") claimEntities[ref] = entry.entityIds ?? [];
		data.worldEntities = world.entities;
		data.worldClaims = world.claims;
	}
	const goals = describeGoals(env, [
		"adopted",
		"proposed",
		"completed",
		"withdrawn",
	]);
	if (goals && goals.goals.length > 0) {
		for (const [ref, entry] of Object.entries(goals.refs))
			refs[ref] = {
				namespace: "goal",
				id: entry.goalId,
				revision: entry.revision,
			};
		for (const goal of goals.goals) shown[goal.ref] = [goal.text];
		data.goals = goals.goals;
	}
	return { refs, shown, claimEntities, data };
}

function prepareStep(env: StepEnv, unit: PreparedUnit["unit"]) {
	const built = buildPrepared(env, unit);
	if (!built) return { status: "stale" as const, reason: "nothing_to_do" };
	const { kept, requestRows } = built;
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
		return eventView(label, entry.loaded, true);
	});
	const requests: CurateContext["requests"] = {};
	const requestViews = requestRows.map((row, i) => {
		const id = `r${i + 1}`;
		const event = labelOf.get(`m:${row.sourceRef}`) ?? "";
		requests[id] = {
			id: row.id,
			what: row.what,
			detail: row.detail,
			// A request that names its target in words is the agency's: never one of these.
			kind: row.kind as RequestKind,
			messageId: row.sourceRef,
			event,
		};
		return {
			id,
			kind: row.kind,
			what: row.what,
			...(row.detail ? { detail: row.detail } : {}),
			event,
		};
	});
	const memory = describeMemory(env, {
		includeInactive: requestRows.some((row) => row.kind === "forget"),
	});
	const shelves = describeShelves(env, requestRows, kept);
	const shownMemory: CurateContext["shown"] = {};
	for (const entry of memory.longTerm)
		shownMemory[String(entry.ref)] = [String(entry.text)];
	const context: CurateContext = {
		events,
		requests,
		refs: { ...memory.refs, ...shelves.refs },
		shown: { ...shownMemory, ...shelves.shown },
		claimEntities: shelves.claimEntities,
		eventTexts: Object.fromEntries(
			kept.map((entry, i) => [
				eventLabel(entry.loaded, i),
				entry.loaded.text.text,
			]),
		),
	};
	return {
		status: "ready" as const,
		data: {
			today: localDay(env.deps.nowMs()),
			events: views,
			requests: requestViews,
			longTerm: memory.longTerm,
			longTermCoverage: memory.coverage,
			...shelves.data,
		},
		targets: { requests: requestRows.map((r) => r.id) },
		context,
	};
}

// ---- execute: the search for what a forget request touches ----

async function findCandidates(
	prepared: PreparedUnit,
	ctx: ExecuteContext,
): Promise<{
	views: Array<Record<string, unknown>>;
	map: Candidates;
	texts: Record<string, string>;
}> {
	const context = prepared.context as CurateContext;
	const forgets = Object.values(context.requests)
		.filter((r) => r.kind === "forget")
		.slice(0, FORGET_SEARCHES);
	const views: Array<Record<string, unknown>> = [];
	const map: Candidates = {};
	const texts: Record<string, string> = {};
	if (forgets.length === 0) return { views, map, texts };
	const { deps } = ctx;
	const shown = new Set(
		Object.values(context.events)
			.map((e) => e.messageId)
			.filter((id): id is string => id !== null),
	);
	for (const request of forgets) {
		if (views.length >= CANDIDATES_TOTAL) break;
		const what = request.what;
		const vector = await deps.memory.vectors.embedQuery(what, ctx.signal);
		if (!vector) continue;
		deps.store.read((db) => {
			const found = deps.memory.recallTurnsInRead(db, {
				conversationId: prepared.unit.conversationId,
				space: vector.space,
				vector: vector.vector,
				limit: CANDIDATES_PER_REQUEST,
				minScore: RECALL_MIN_SCORE,
				excludeMessageIds: [...shown, ...Object.values(map).flat()],
			});
			const seen = new Set<string>();
			for (const pin of found?.pins ?? []) {
				const message = deps.conversation.messageInTransaction(
					db,
					pin.messageId,
				);
				if (!message || !message.message.runId) continue;
				const runId = message.message.runId;
				if (seen.has(runId) || views.length >= CANDIDATES_TOTAL) continue;
				seen.add(runId);
				const run = deps.conversation.messagesOfRunInTransaction(
					db,
					prepared.unit.conversationId,
					runId,
				);
				const user = run.find((m) => m.message.role === "user");
				const answer = run.find((m) => m.message.role === "assistant");
				const label = `xc${views.length + 1}`;
				map[label] = run.map((m) => m.message.id);
				texts[label] = user?.message.text ?? "";
				views.push({
					id: label,
					at: (user ?? answer)?.message.createdAt ?? "",
					user: user ? clipChars(user.message.text, CANDIDATE_CHARS) : null,
					assistant: answer
						? clipChars(answer.message.text, CANDIDATE_CHARS)
						: null,
				});
			}
		});
	}
	return { views, map, texts };
}

async function beforeInfer(prepared: PreparedUnit, ctx: ExecuteContext) {
	const { views, map, texts } = await findCandidates(prepared, ctx);
	const extras: CurateExtras = { candidates: map, candidateTexts: texts };
	return {
		data: {
			...(prepared.data as object),
			...(views.length ? { candidates: views } : {}),
		},
		extras,
	};
}

export const curateMemory: StepDefinition = {
	id: "curate-memory" satisfies StepId,
	slot: "reflect",
	longTerm: true,
	instructions,
	outputSchema: (prepared) =>
		curateSchema(Object.keys((prepared.context as CurateContext).requests)),
	prepare: (env, unit) => prepareStep(env, unit),
	parse: parseCurate,
	beforeInfer,
	apply: (env, prepared, output, extras) =>
		applyCurate(env, prepared, output, extras),
};
