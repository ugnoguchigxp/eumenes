import { RECALL_MIN_SCORE } from "../../../memory";
import { type StepId } from "../../contracts";
import {
	type InboxRow,
	readInbox,
	resolveInbox,
	type UnitTargets,
} from "../../repository";
import { clipChars, fitExchanges } from "../budget";
import {
	type LabelTable,
	type LoadedExchange,
	describeMemory,
	exchangeView,
	loadExchange,
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

type Entry = {
	loaded: LoadedExchange;
	target: boolean;
	reference: boolean;
	requestIds: string[];
	bytes: number;
};

function prepare(env: StepEnv, unit: { targets: UnitTargets }) {
	const { db, deps } = env;
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
		const registered = deps.memory.exchangeInTransaction(db, row.messageId);
		const loaded = loadExchange(
			env,
			registered
				? registered
				: {
						inputMessageId: row.messageId,
						answerMessageId: null,
						outcome: "request_only",
					},
		);
		if (loaded.status !== "ok") {
			dropRequest.push({
				id,
				code:
					loaded.status === "blocked" ? "source_blocked" : "source_unavailable",
			});
			continue;
		}
		requests.push(row);
		const existing = entries.get(row.messageId);
		if (existing) existing.requestIds.push(id);
		else
			entries.set(row.messageId, {
				loaded: loaded.exchange,
				target: false,
				reference: true,
				requestIds: [id],
				bytes: loaded.exchange.bytes,
			});
	}
	const skipped: string[] = [];
	for (const id of unit.targets.exchanges ?? []) {
		const row = deps.memory.exchangeInTransaction(db, id);
		if (!row || row.curated !== null) continue;
		const loaded = loadExchange(env, row);
		if (loaded.status !== "ok") {
			if (loaded.status === "gone") skipped.push(id);
			continue;
		}
		const existing = entries.get(id);
		if (existing) {
			existing.target = true;
			existing.reference = false;
		} else
			entries.set(id, {
				loaded: loaded.exchange,
				target: true,
				reference: false,
				requestIds: [],
				bytes: loaded.exchange.bytes,
			});
	}
	return { entries, requests, dropRequest, skipped };
}

function buildPrepared(env: StepEnv, unit: PreparedUnit["unit"]) {
	const { db, deps } = env;
	const found = prepare(env, unit);
	for (const id of found.skipped)
		deps.memory.markExchangeStepInTransaction(db, id, "curated", "skipped");
	const now = deps.clock();
	for (const { id, code } of found.dropRequest)
		resolveInbox(db, id, "none", code, now);
	// Requests first (their exchanges are the context they need), then the exchanges this unit marks.
	const ordered = [...found.entries.values()].sort((a, b) => {
		const ra = a.requestIds.length > 0 ? 0 : 1;
		const rb = b.requestIds.length > 0 ? 0 : 1;
		return ra - rb || a.loaded.ordinal - b.loaded.ordinal;
	});
	const { fit } = fitExchanges(ordered);
	const kept = fit.sort((a, b) => a.loaded.ordinal - b.loaded.ordinal);
	const keptRequestIds = new Set(kept.flatMap((e) => e.requestIds));
	const requestRows = found.requests.filter((r) => keptRequestIds.has(r.id));
	const targetEntries = kept.filter((e) => e.target);
	if (targetEntries.length === 0 && requestRows.length === 0) return null;
	return { kept, requestRows, targetEntries };
}

/**
 * World's claims and entities and the goals, as refs a forget request may name (F3, F4, F8). Shown only when the unit
 * holds a forget request: they cost tokens and nothing else of this step uses them.
 */
function describeShelves(
	env: StepEnv,
	requestRows: readonly InboxRow[],
	kept: ReadonlyArray<{ loaded: LoadedExchange; target: boolean }>,
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
		...kept.flatMap((e) => [e.loaded.user.text]),
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
	const { kept, requestRows, targetEntries } = built;
	const exchanges: LabelTable = {};
	const labelOf = new Map<string, string>();
	const views = kept.map((entry, i) => {
		const label = `e${i + 1}`;
		labelOf.set(entry.loaded.inputMessageId, label);
		exchanges[label] = {
			inputMessageId: entry.loaded.inputMessageId,
			answerMessageId: entry.loaded.answerMessageId,
			outcome: entry.loaded.outcome,
		};
		return exchangeView(label, entry.loaded, !entry.target);
	});
	const requests: CurateContext["requests"] = {};
	const requestViews = requestRows.map((row, i) => {
		const id = `r${i + 1}`;
		const exchange = labelOf.get(row.messageId) ?? "";
		requests[id] = {
			id: row.id,
			what: row.what,
			detail: row.detail,
			kind: row.kind,
			messageId: row.messageId,
			exchange,
		};
		return {
			id,
			kind: row.kind,
			what: row.what,
			...(row.detail ? { detail: row.detail } : {}),
			exchange,
		};
	});
	const memory = describeMemory(env);
	const shelves = describeShelves(env, requestRows, kept);
	const digests: Record<string, string> = {};
	const turns: CurateContext["turns"] = [];
	const sources: CurateContext["sources"] = {};
	for (const entry of targetEntries) {
		for (const id of [
			entry.loaded.inputMessageId,
			entry.loaded.answerMessageId,
		]) {
			if (id === null) continue;
			const state = env.deps.conversation.sourceInTransaction(env.db, id);
			if (state.state === "available")
				sources[id] = { revision: state.revision, digest: state.digest };
		}
		Object.assign(digests, entry.loaded.digests);
		turns.push({
			messageId: entry.loaded.inputMessageId,
			text: entry.loaded.user.text,
		});
		if (entry.loaded.answerMessageId && entry.loaded.assistant)
			turns.push({
				messageId: entry.loaded.answerMessageId,
				text: entry.loaded.assistant.text,
			});
	}
	const shownMemory: CurateContext["shown"] = {};
	for (const entry of memory.longTerm)
		shownMemory[String(entry.ref)] = [String(entry.text)];
	const context: CurateContext = {
		exchanges,
		targetIds: targetEntries.map((e) => e.loaded.inputMessageId),
		requests,
		refs: { ...memory.refs, ...shelves.refs },
		shown: { ...shownMemory, ...shelves.shown },
		claimEntities: shelves.claimEntities,
		exchangeTexts: Object.fromEntries(
			kept.map((entry, i) => [`e${i + 1}`, entry.loaded.user.text]),
		),
		sources,
		digests,
		turns,
		noteTexts: memory.shortTerm.map((note) => String(note.text)),
	};
	return {
		status: "ready" as const,
		data: {
			today: localDay(env.deps.nowMs()),
			exchanges: views,
			requests: requestViews,
			longTerm: memory.longTerm,
			longTermCoverage: memory.coverage,
			shortTerm: memory.shortTerm,
			...shelves.data,
		},
		targets: {
			exchanges: context.targetIds,
			requests: requestRows.map((r) => r.id),
		},
		summaryRevision: null,
		context,
	};
}

// ---- execute: turn vectors beside the inference, and the search for what a forget request touches ----

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
		Object.values(context.exchanges).flatMap((e) =>
			[e.inputMessageId, e.answerMessageId].filter(
				(id): id is string => id !== null,
			),
		),
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
				maxTokens: deps.memory.historyBudgetTokens(),
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
				const label = `c${views.length + 1}`;
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
	const context = prepared.context as CurateContext;
	const turnVectors = ctx.deps.memory.vectors.embedTurns(
		context.turns,
		ctx.signal,
	);
	const { views, map, texts } = await findCandidates(prepared, ctx);
	const extras: CurateExtras = {
		turnVectors,
		candidates: map,
		candidateTexts: texts,
	};
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
	afterInfer: async (_prepared, _output, extras) => ({
		...(extras as CurateExtras),
		turnVectors: await (extras as CurateExtras).turnVectors,
	}),
	apply: (env, prepared, output, extras) =>
		applyCurate(env, prepared, output, extras),
};
