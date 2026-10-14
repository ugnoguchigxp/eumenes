import { PREFETCH_BYTES, RECALL_MIN_SCORE } from "../../../memory";
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
import { instructions } from "../prompts/curate-memory";
import { curateSchema } from "../schemas";
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
	const digests: Record<string, string> = {};
	const turns: CurateContext["turns"] = [];
	for (const entry of targetEntries) {
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
	const context: CurateContext = {
		exchanges,
		targetIds: targetEntries.map((e) => e.loaded.inputMessageId),
		requests,
		refs: memory.refs,
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
			shortTerm: memory.shortTerm,
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
): Promise<{ views: Array<Record<string, unknown>>; map: Candidates }> {
	const context = prepared.context as CurateContext;
	const forgets = Object.values(context.requests)
		.filter((r) => r.kind === "forget")
		.slice(0, FORGET_SEARCHES);
	const views: Array<Record<string, unknown>> = [];
	const map: Candidates = {};
	if (forgets.length === 0) return { views, map };
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
				maxBytes: PREFETCH_BYTES,
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
	return { views, map };
}

async function beforeInfer(prepared: PreparedUnit, ctx: ExecuteContext) {
	const context = prepared.context as CurateContext;
	const turnVectors = ctx.deps.memory.vectors.embedTurns(
		context.turns,
		ctx.signal,
	);
	const { views, map } = await findCandidates(prepared, ctx);
	const extras: CurateExtras = { turnVectors, candidates: map };
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
	outputSchema: curateSchema,
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
