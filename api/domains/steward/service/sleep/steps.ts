import type { Database } from "bun:sqlite";
import {
	type ConsolidationResult,
	type DeepDeps,
	type GoalInput,
	type ShallowDeps,
	runDeep,
	runShallow,
} from "eumenes-consolidation";
import type { PlanItem as ContinuityPlan } from "../../../continuity";
import type { PlanItem } from "eumenes-consolidation";
import { getLogger } from "../../../../infrastructure/logger";
import { sha256Hex } from "../../../../infrastructure/digest";
import { FORGET_KEY, type SleepStepId, type StepId } from "../../contracts";
import {
	type ForgetExclusion,
	bumpInboxFailure,
	readInbox,
	readSleepState,
	resolveInbox,
	setDeepDay,
	setShallowWatermark,
	writePositions,
} from "../../repository";
import { describeGoals } from "../goals-view";
import { noticeInTransaction } from "../notices";
import { executeForget } from "../steps/curate-forget";
import { pendingEvents } from "../steps/shared";
import type {
	SleepInput,
	SleepSettle,
	SleepStepDefinition,
	StepEnv,
	StewardDeps,
} from "../types";
import {
	LIBRARY_SCOPE,
	evidenceReader,
	judgeLlm,
	libraryAccess,
	memoryStore,
} from "./library";
import { createSleepOutlets } from "./outlets";
import { SLEEP_POLICY, jstDay, localNow } from "./policy";
import { anyForeground } from "./rest";

const log = getLogger("steward");
const LONG_TERM_KEY = "steward:long-term";

// ---- what the steps hand between prepare, run and settle ----

type Turn = {
	conversationId: string;
	messageId: string;
	seq: number;
	digest: string;
};
type Prepared = {
	turns: Turn[];
	/** The event seqs of each conversation the embedding covers (marked handled when it is settled). */
	seqs: Record<string, number[]>;
	plans: PlanItem[];
	goals: GoalInput[];
};
type Run = {
	vectors: Awaited<
		ReturnType<StewardDeps["memory"]["vectors"]["embedTurns"]>
	> | null;
	consolidation: ConsolidationResult | null;
	/** There were turns to embed and the embedding gave nothing: the events are not handled. */
	embedFailed?: boolean;
	/** A write of the run found the ground moved (why): nothing of it was written. */
	fenced?: string;
};

const planState = (state: ContinuityPlan["state"]): PlanItem["state"] =>
	state === "awaiting_confirmation"
		? "awaiting-confirmation"
		: state === "closed"
			? "done"
			: state;

/** The open plans (L3) as the library reads them: the plan's id is its reference. */
function openPlans(deps: StewardDeps, db: Database): PlanItem[] {
	return deps.continuity.plans.listInTransaction(db).map((plan) => ({
		ref: plan.id,
		text: plan.text,
		dueAt: plan.dueAt,
		state: planState(plan.state),
	}));
}

/** The handled events whose turns are not embedded yet, oldest first across conversations, at most one unit's worth. */
function embedTargets(env: StepEnv): Pick<Prepared, "turns" | "seqs"> {
	const { db, deps } = env;
	const turns: Turn[] = [];
	const seqs: Record<string, number[]> = {};
	for (const conversationId of deps.continuity.events.conversationsWithUncuratedInTransaction(
		db,
	)) {
		const here: StepEnv = { db, deps, conversationId };
		for (const event of pendingEvents(here)) {
			if (Object.values(seqs).flat().length >= SLEEP_POLICY.embedEventsPerUnit)
				break;
			const messageId = event.messageIds[0];
			const found = messageId
				? deps.conversation.messageInTransaction(db, messageId)
				: null;
			// An event with no message behind it (an announcement) has no turn to embed: it is handled as it is.
			if (messageId && found && found.message.conversationId === conversationId)
				turns.push({
					conversationId,
					messageId,
					seq: event.seq,
					digest: sha256Hex(found.message.text),
				});
			(seqs[conversationId] ??= []).push(event.seq);
		}
	}
	return { turns, seqs };
}

/**
 * `embedTurns` answers null both when no embedder is set up and when the one that is failed. A query tells them
 * apart: null means there is no embedder (the events are handled without vectors, as before); an answer or an
 * error means there is one, and the turns it could not embed are tried again.
 */
async function embedderAnswers(
	deps: StewardDeps,
	signal: AbortSignal,
): Promise<boolean> {
	try {
		return (await deps.memory.vectors.embedQuery("確認", signal)) !== null;
	} catch {
		return true;
	}
}

/** The goals as the library reads them, by the goal's own id (the instruction names it back). */
function deepGoals(env: StepEnv): GoalInput[] {
	const view = describeGoals(env, ["adopted", "proposed"]);
	return (
		view?.goals.map((goal) => ({
			id: view.refs[goal.ref]!.goalId,
			text: goal.text,
			state: goal.status,
		})) ?? []
	);
}

/** The ground a run stood on moved while it worked: its write found out in its own transaction and wrote nothing. */
class SleepFenced extends Error {}

/**
 * The checks every write of a sleep run makes first, in the transaction that writes: memory is still usable, no
 * forget came since prepare, and no conversation run began (the unit's settle checks the same). A unit that
 * is the forget itself skips them.
 */
function fenceOf(deps: StewardDeps, input: SleepInput) {
	return (db: Database) => {
		if (input.step.urgent) return;
		if (!deps.memory.readyInTransaction(db))
			throw new SleepFenced("memory_unavailable");
		if (
			input.forgetSeq !== null &&
			input.forgetSeq !== deps.memory.forgetSeqInTransaction(db)
		)
			throw new SleepFenced("stale_forget");
		if (anyForeground(db, deps)) throw new SleepFenced("foreground_active");
	};
}

/** The library's dependencies for one run: its store, its model calls and its evidence, bound to this unit. */
function libraryDeps(
	deps: StewardDeps,
	input: SleepInput,
	signal: AbortSignal,
	db: Database,
): { shallow: ShallowDeps; llm: ReturnType<typeof judgeLlm> } {
	const llm = judgeLlm(deps, {
		jobId: input.jobId,
		attempt: input.attempt,
		generation: input.generation,
	});
	return {
		llm,
		shallow: {
			store: memoryStore(deps, fenceOf(deps, input)),
			llm,
			evidence: evidenceReader(deps),
			access: libraryAccess(db, deps),
			scopeKey: LIBRARY_SCOPE,
			sourceRunId: `${input.unitId}`,
			now: deps.nowMs,
			...(deps.sleep?.config ? { config: deps.sleep.config } : {}),
			signal,
		},
	};
}

/**
 * A model call that did not finish ends the unit as the error says (a yield to the conversation is not a failure),
 * not as an unadopted result: the same unit made again later reads the same candidates.
 */
function raiseModelFailure(
	result: ConsolidationResult,
	llm: ReturnType<typeof judgeLlm>,
) {
	const failed = result.notAdopted.some((entry) => entry.kind === "llm");
	const error = llm.lastError();
	if (!result.adopted && failed && error !== undefined) throw error;
}

function countsOf(result: ConsolidationResult) {
	const applied: Record<string, number> = {};
	for (const change of result.applied)
		applied[change.kind] = (applied[change.kind] ?? 0) + 1;
	const notAdopted: Record<string, number> = {};
	for (const entry of result.notAdopted)
		notAdopted[entry.kind] = (notAdopted[entry.kind] ?? 0) + 1;
	return { adopted: result.adopted, applied, notAdopted };
}

/** The instructions an adopted run gives back, to their outlets (inside the settle transaction). */
export function deliver(
	env: StepEnv,
	result: ConsolidationResult,
	options: { deep: boolean; goals?: readonly GoalInput[] },
) {
	const { db, deps } = env;
	const outlets = createSleepOutlets(deps);
	const { instructions } = result;
	if (instructions.plans.length > 0)
		outlets.plansDue(db, localNow(deps.nowMs()));
	if (instructions.unresolved.length > 0)
		outlets.unresolved(db, instructions.unresolved);
	if (instructions.relinks.length > 0)
		outlets.relinks(db, instructions.relinks);
	if (options.deep) {
		if (instructions.prep.length > 0) outlets.prep(db, instructions.prep);
		if (instructions.goals.length > 0)
			outlets.goals(db, instructions.goals, options.goals ?? []);
	}
}

// ---- shallow ----

/**
 * The shallow consolidation: embeds the turns of the handled events together (not at every exchange), moves the
 * plans past their date to "awaiting confirmation", and, once enough candidates are new, merges the duplicate ones
 * through the library (`runShallow`). World's events are curated by their own units while the conversation rests.
 */
export const shallow: SleepStepDefinition = {
	id: "shallow",
	slot: "maintenance",
	concurrencyKey: LONG_TERM_KEY,
	urgent: false,
	prepare(env, unit) {
		const { embed, consolidate } = unit.targets;
		const targets = embed ? embedTargets(env) : { turns: [], seqs: {} };
		const embeds = Object.keys(targets.seqs).length > 0;
		if (!embeds && !consolidate)
			return { status: "stale", reason: "nothing_to_do" };
		const prepared: Prepared = {
			...targets,
			plans: openPlans(env.deps, env.db),
			goals: [],
		};
		return {
			status: "ready",
			prepared,
			targets: { embed: embeds, consolidate: consolidate === true },
		};
	},
	async run(input, ctx) {
		const { deps, signal } = ctx;
		const prepared = input.prepared as Prepared;
		const run: Run = { vectors: null, consolidation: null };
		if (prepared.turns.length > 0) {
			const turns = deps.store.read((db) =>
				prepared.turns.flatMap((turn) => {
					const source = deps.conversation.sourceInTransaction(
						db,
						turn.messageId,
					);
					if (
						source.state !== "available" ||
						deps.memory.blockedMessageIdsInTransaction(db, [turn.messageId])
							.size
					)
						return [];
					const found = deps.conversation.messageInTransaction(
						db,
						turn.messageId,
					);
					return found && sha256Hex(found.message.text) === turn.digest
						? [{ messageId: turn.messageId, text: found.message.text }]
						: [];
				}),
			);
			run.vectors = await deps.memory.vectors.embedTurns(turns, signal);
			run.embedFailed =
				turns.length > 0 &&
				run.vectors === null &&
				(await embedderAnswers(deps, signal));
		}
		if (input.targets.consolidate) {
			const { shallow: library, llm } = deps.store.read((db) =>
				libraryDeps(deps, input, signal, db),
			);
			const state = deps.store.read((db) => readSleepState(db));
			try {
				run.consolidation = await runShallow(library, {
					sinceSeq: state.shallowWatermark,
					plans: prepared.plans,
				});
				raiseModelFailure(run.consolidation, llm);
			} catch (error) {
				if (!(error instanceof SleepFenced)) throw error;
				run.fenced = error.message;
			}
		}
		return run;
	},
	settle(env, input, raw): SleepSettle {
		const { db, deps } = env;
		const prepared = input.prepared as Prepared;
		const run = raw as Run;
		const refs: SleepSettle["refs"] = [];
		if (run.fenced) return { results: {}, refs, stale: run.fenced };
		// The turns' vectors and the events' handled marks. Turns that could not be embedded leave their events unhandled.
		const digests: Record<string, Record<string, string>> = {};
		for (const turn of prepared.turns)
			(digests[turn.conversationId] ??= {})[turn.messageId] = turn.digest;
		for (const [conversationId, seqs] of run.embedFailed
			? []
			: Object.entries(prepared.seqs)) {
			if (run.vectors)
				deps.memory.vectors.saveTurnVectors(
					db,
					{ conversationId, digests: digests[conversationId] ?? {} },
					{
						space: run.vectors.space,
						items: run.vectors.items.filter(
							(item) => digests[conversationId]?.[item.messageId] !== undefined,
						),
					},
				);
			deps.continuity.events.markCuratedInTransaction(db, conversationId, seqs);
		}
		// The plans past their date wait for the user's word, whether or not candidates were consolidated.
		createSleepOutlets(deps).plansDue(db, localNow(deps.nowMs()));
		const results: Record<string, unknown> = {
			embedded: run.embedFailed
				? 0
				: Object.values(prepared.seqs).flat().length,
		};
		const embedFailure = run.embedFailed
			? { failed: { code: "embedding_failed", count: true } }
			: {};
		const consolidation = run.consolidation;
		if (!consolidation) return { results, refs, ...embedFailure };
		results.consolidation = countsOf(consolidation);
		if (!consolidation.adopted)
			return { results, refs, failed: { code: "not_adopted", count: true } };
		if (consolidation.watermark !== undefined)
			setShallowWatermark(db, consolidation.watermark);
		deliver(env, consolidation, { deep: false });
		return { results, refs, ...embedFailure };
	},
};

// ---- deep ----

/** The deep consolidation (`runDeep`): promotes what several conversations observed, marks contradictions unresolved, tidies plans. */
export const deep: SleepStepDefinition = {
	id: "deep",
	slot: "maintenance",
	concurrencyKey: LONG_TERM_KEY,
	urgent: false,
	prepare(env, unit) {
		const prepared: Prepared = {
			turns: [],
			seqs: {},
			plans: openPlans(env.deps, env.db),
			goals: deepGoals(env),
		};
		return {
			status: "ready",
			prepared,
			targets: {
				supplement: unit.targets.supplement === true,
				...(unit.targets.positions
					? { positions: unit.targets.positions }
					: {}),
			},
		};
	},
	async run(input, ctx) {
		const { deps, signal } = ctx;
		const prepared = input.prepared as Prepared;
		const { shallow: library, llm } = deps.store.read((db) =>
			libraryDeps(deps, input, signal, db),
		);
		const outlets = createSleepOutlets(deps);
		const deepDeps: DeepDeps = {
			...library,
			writeTendency: (db, tendency) =>
				outlets.writeTendency(db as Database, tendency),
		};
		try {
			const consolidation = await runDeep(deepDeps, {
				plans: prepared.plans,
				tendencies: [],
				goals: prepared.goals,
				conflictHints: [],
			});
			raiseModelFailure(consolidation, llm);
			return { vectors: null, consolidation } satisfies Run;
		} catch (error) {
			if (!(error instanceof SleepFenced)) throw error;
			return { vectors: null, consolidation: null, fenced: error.message };
		}
	},
	settle(env, input, raw): SleepSettle {
		const { db, deps } = env;
		const run = raw as Run;
		if (run.fenced) return { results: {}, refs: [], stale: run.fenced };
		const consolidation = run.consolidation!;
		const results: Record<string, unknown> = {
			consolidation: countsOf(consolidation),
		};
		if (!consolidation.adopted)
			return {
				results,
				refs: [],
				failed: { code: "not_adopted", count: true },
			};
		deliver(env, consolidation, {
			deep: true,
			goals: (input.prepared as Prepared).goals,
		});
		const outlets = createSleepOutlets(deps);
		outlets.plansDue(db, localNow(deps.nowMs()));
		outlets.pruneClosedPlans(db);
		// What the run covered is not counted again; the day is used up only by a run of the time window.
		writePositions(db, input.targets.positions ?? {});
		if (input.targets.supplement !== true) setDeepDay(db, jstDay(deps.nowMs()));
		return { results, refs: [] };
	},
};

// ---- the closure delete of a forget ----

/**
 * The forgets whose targets were excluded at once (the redesign, section 9.2): their closure delete removes every
 * version and what was derived from them, whether or not a conversation run is going. It asks no model.
 */
export const forgetClosure: SleepStepDefinition = {
	id: "forget-closure",
	slot: "maintenance",
	concurrencyKey: FORGET_KEY,
	urgent: true,
	prepare(env, unit) {
		const ids = (unit.targets.requests ?? []).filter(
			(id) => readInbox(env.db, id)?.state === "excluded",
		);
		// What the library holds excluded that no request names (a restored database): the target list is theirs too.
		const orphans = unit.targets.orphans ?? [];
		if (ids.length === 0 && orphans.length === 0)
			return { status: "stale", reason: "nothing_to_do" };
		return {
			status: "ready",
			prepared: null,
			targets: {
				requests: ids,
				urgent: true,
				...(orphans.length > 0 ? { orphans } : {}),
			},
		};
	},
	async run() {
		return null;
	},
	settle(env, input): SleepSettle {
		const { db, deps } = env;
		const now = deps.clock();
		const results: unknown[] = [];
		const refs: SleepSettle["refs"] = [];
		let failed = false;
		for (const id of input.targets.requests ?? []) {
			const row = readInbox(db, id);
			if (row?.state !== "excluded" || row.exclusion === null) continue;
			refs.push({ type: "request", id });
			const spec = JSON.parse(row.exclusion) as ForgetExclusion;
			let code: string | null = null;
			try {
				const effect = executeForget(
					{ db, deps, conversationId: row.conversationId },
					spec,
					{ close: true },
				);
				if (effect.status === "refused") code = effect.code;
			} catch (error) {
				log.warn(
					"steward.forget_closure_failed",
					{ reason: "forget_failed" },
					error,
				);
				code = "forget_failed";
			}
			if (code === null) {
				resolveInbox(db, id, "done", null, now);
				noticeInTransaction(
					deps,
					db,
					row.conversationId,
					"忘れる依頼を実行しました。",
					`${input.unitId}:${id}`,
				);
				results.push({ request: id, status: "applied" });
			} else {
				// The exclusion stays in force: the closure is tried again, whatever the count.
				bumpInboxFailure(db, id);
				failed = true;
				results.push({ request: id, status: "rejected", code });
			}
		}
		// What the library holds excluded that no request names (a restored database): closed under no conversation.
		const orphans = input.targets.orphans ?? [];
		if (orphans.length > 0) {
			let code: string | null = null;
			try {
				const effect = executeForget(
					{ db, deps, conversationId: FORGET_KEY },
					{
						itemIds: orphans,
						messageIds: [],
						claimIds: [],
						entityIds: [],
						goalIds: [],
					},
					{ close: true },
				);
				if (effect.status === "refused") code = effect.code;
			} catch (error) {
				log.warn(
					"steward.forget_closure_failed",
					{ reason: "forget_failed" },
					error,
				);
				code = "forget_failed";
			}
			results.push(
				code === null
					? { orphans: orphans.length, status: "applied" }
					: { orphans: orphans.length, status: "rejected", code },
			);
			if (code !== null) failed = true;
		}
		return {
			results,
			refs,
			...(failed
				? { failed: { code: "forget_closure_failed", count: true } }
				: {}),
		};
	},
};

export const sleepSteps: Record<SleepStepId, SleepStepDefinition> = {
	shallow,
	deep,
	"forget-closure": forgetClosure,
};
export const isSleepStep = (step: StepId): step is SleepStepId =>
	step in sleepSteps;
