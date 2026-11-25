import type { Database } from "bun:sqlite";
import type {
	AgendaCall,
	AgendaMarks,
	AgendaRecords,
	KnownItem,
} from "eumenes-agency/agenda";
import { touchesSuppressedTerm } from "../../domains/memory";
import { PRINCIPAL, PROFILE_SCOPE } from "../../domains/memory/contracts";
import type { AgendaScope } from "./always-on-scope";
import type { AgencyHostDeps } from "./host-types";
import { planReference, planReferenceKind } from "./plan-reference";

/**
 * What the host hands the agenda package to read (spec 2026-11-22 §5.4): the memory that bears on each call
 * (`known`), the plans, goals, unresolved conflicts and question ledger (`records`), and the marks on them (`marks`:
 * under review, suppressed). Everything is read when the package asks, in a read of its own.
 */

/** How many memory items each call is given. Only the plan is given more than what bears on it (the newest fill it). */
export const KNOWN_LIMITS = { plan: 12, compose: 6, ask_check: 6 } as const;
/** How many plans, goals, conflicts and ledger entries each call is given. */
export const RECORD_LIMITS = {
	plans: 8,
	goals: 10,
	conflicts: 5,
	questions: 60,
	/** What a draft is given of the plans and goals: those that bear on its topic. */
	topical: 3,
} as const;

const SEPARATORS = /[\s、。，．,.!?！？…・「」『』（）()]/gu;
const fold = (text: string) => text.normalize("NFKC").toLowerCase();

/** The pairs of adjacent characters of a text (a one-character text is its own unit): the words two texts share. */
export function unitsOf(text: string): Set<string> {
	const chars = [...fold(text).replace(SEPARATORS, "")];
	const out = new Set<string>();
	if (chars.length === 1) out.add(chars[0]!);
	for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i]! + chars[i + 1]!);
	return out;
}

/** How many units of `wanted` the text has. */
export function overlap(wanted: ReadonlySet<string>, text: string): number {
	let n = 0;
	for (const unit of unitsOf(text)) if (wanted.has(unit)) n++;
	return n;
}

/** The items best matching `wanted` first (score above zero only); ties keep the given order. */
function rank<T>(
	items: readonly T[],
	wanted: ReadonlySet<string>,
	text: (item: T) => string,
): T[] {
	return items
		.map((item, i) => ({ item, i, score: overlap(wanted, text(item)) }))
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score || a.i - b.i)
		.map((x) => x.item);
}

type StateItems = ReturnType<
	AgencyHostDeps["memory"]["stateItemsInTransaction"]
>;

/**
 * The memory items of the profile in force now (suppressed and excluded ones are not listed, nor the ones marked
 * sensitive or about another person: a line the agent starts on its own does not bring them up), newest update first.
 */
export function currentItems(
	deps: AgencyHostDeps,
	db: Database,
	now: number,
): StateItems {
	const status = deps.memory.status();
	if (!status.enabled || !status.healthy) return [];
	try {
		const items = deps.memory.stateItemsInTransaction(db, false);
		const marked = deps.memory.marksInTransaction(
			db,
			items.map((item) => item.itemId),
		);
		return [...items]
			.filter(
				(item) =>
					item.status === "active" &&
					!marked.has(item.itemId) &&
					(item.validFromMs === null || item.validFromMs <= now) &&
					(item.validUntilMs === null || item.validUntilMs > now),
			)
			.sort((a, b) => b.updatedSeq - a.updatedSeq);
	} catch {
		// A refusal says nothing to a background call: it reads no memory.
		return [];
	}
}

/** The topic words the user asked not to be brought up. A read that fails fails the call: nothing is let through. */
const suppressedTerms = (deps: AgencyHostDeps, db: Database): string[] =>
	deps.memory.suppressionsInTransaction(db).terms;

/**
 * The messages the memory keeps from the agency now: forgotten, blocked, or withheld while a forget is on its way
 * (excluded, before the closure delete). One test for the words, the goals and the records that rest on a message.
 */
export function withheldIds(
	deps: AgencyHostDeps,
	db: Database,
	ids: readonly string[],
): Set<string> {
	const out = new Set(
		ids.filter((id) => deps.memory.isBlockedInTransaction?.(db, id)),
	);
	const rest = ids.filter((id) => !out.has(id));
	if (rest.length && deps.memory.withheldMessagesInTransaction)
		for (const id of deps.memory.withheldMessagesInTransaction(db, rest))
			out.add(id);
	return out;
}

/**
 * The goals in the agenda's slots, in slot order, without a goal that rests on a message the memory withholds.
 * `state` is the short Japanese word the user would use; a withdrawn goal is not in the slots.
 */
export function slotGoals(deps: AgencyHostDeps, db: Database) {
	const goals = deps.agendaGoals;
	if (!goals) return [];
	return goals.store.list(goalAccess).flatMap(({ slot, goal }) => {
		const state = goal ? GOAL_STATE_WORD[goal.status] : undefined;
		if (!goal || !state) return [];
		const sources = goals.sourceMessageIds?.(db, goal.goalId) ?? [];
		return withheldIds(deps, db, sources).size > 0
			? []
			: [{ slot, goalId: goal.goalId, text: goal.desiredState, state }];
	});
}

const GOAL_STATE_WORD: Record<string, string> = {
	adopted: "進行中",
	proposed: "提案中",
	completed: "完了",
};

const goalAccess = { principal: PRINCIPAL, scopeKeys: [PROFILE_SCOPE] };

/** What a call is about, as text: the words the host matches the records against. */
function topicOf(call: AgendaCall, said: readonly string[]): string {
	if (call.purpose === "compose")
		return `${call.item.text} ${call.item.topic ?? ""}`;
	if (call.purpose === "ask_check") return call.asks.join("\n");
	return said.slice(-6).join("\n");
}

/**
 * The memory the agent's call is given: what bears on it (the user's latest words for a plan, the line's topic for a
 * draft, the questions for the ask check), with the newest items filling a plan up to its limit. A suppressed item is
 * left out by the memory's own listing, an excluded one is not listed at all. Each item is `memory:<id>`.
 */
export function knownFor(
	deps: AgencyHostDeps,
	call: AgendaCall,
	said: readonly string[],
	now: number,
): KnownItem[] {
	const items = deps.store.read((db) => currentItems(deps, db, now));
	const wanted = unitsOf(topicOf(call, said));
	const limit = KNOWN_LIMITS[call.purpose];
	const chosen = rank(items, wanted, (item) => item.value.text).slice(0, limit);
	if (call.purpose === "plan")
		for (const item of items) {
			if (chosen.length >= limit) break;
			if (!chosen.includes(item)) chosen.push(item);
		}
	return chosen.map((item) => ({
		id: item.itemId,
		text: `${item.value.polarity === "negated" ? "（否定）" : ""}${item.value.text}`,
	}));
}

/**
 * The plans, goals, unresolved conflicts and question ledger a call is given. A plan is `plan:<id>`, a goal
 * `goal:<id>`, a conflict `conflict:<id>` (an unresolved question resting on a memory item). A plan, goal or conflict
 * about a suppressed topic is left out (the continuity domain already leaves out what rests on an excluded source).
 */
export function recordsFor(
	deps: AgencyHostDeps,
	call: AgendaCall,
	said: readonly string[],
): AgendaRecords {
	const status = deps.memory.status();
	if (!status.enabled || !status.healthy) return {};
	const wanted = unitsOf(topicOf(call, said));
	const { plans, conflicts, questions, terms, slots } = deps.store.read(
		(db) => {
			const terms = suppressedTerms(deps, db);
			const open = deps.continuity.plans.listInTransaction(db);
			const isConflict = (p: (typeof open)[number]) =>
				planReferenceKind(p) === "conflict";
			return {
				terms,
				slots: slotGoals(deps, db),
				plans: open.filter((p) => !isConflict(p)),
				conflicts: open.filter(isConflict),
				questions:
					call.purpose === "compose"
						? []
						: deps.continuity.questions.listInTransaction(db, {
								limit: RECORD_LIMITS.questions,
							}),
			};
		},
	);
	const spoken = (text: string) => !touchesSuppressedTerm(terms, text);
	const goals = slots
		.filter((goal) => spoken(goal.text))
		.map((goal) => ({ ref: goal.goalId, text: goal.text, state: goal.state }));
	const livePlans = plans.filter((p) => spoken(p.text));
	if (call.purpose === "ask_check")
		return {
			questions: questions.map((q) => ({
				attribute: q.attribute,
				state: q.state,
			})),
		};
	if (call.purpose === "compose")
		return {
			plans: rank(livePlans, wanted, (p) => p.text)
				.slice(0, RECORD_LIMITS.topical)
				.map((p) => ({ ref: planReference(p), text: p.text, dueAt: p.dueAt })),
			goals: rank(goals, wanted, (g) => g.text).slice(0, RECORD_LIMITS.topical),
		};
	return {
		// Soonest date first, as the continuity domain lists them.
		plans: livePlans
			.slice(0, RECORD_LIMITS.plans)
			.map((p) => ({ ref: planReference(p), text: p.text, dueAt: p.dueAt })),
		goals: goals.slice(0, RECORD_LIMITS.goals),
		conflicts: conflicts
			.filter((p) => spoken(p.text))
			.slice(0, RECORD_LIMITS.conflicts)
			.map((p) => ({ ref: planReference(p), text: p.text })),
		questions: questions.map((q) => ({
			attribute: q.attribute,
			state: q.state,
		})),
	};
}

/**
 * The memory items whose version was replaced by a correction (the change feed's `correction`), as `memory:<id>`:
 * what the agent holds on them is under review until the host lets it go. Read incrementally, once over the feed.
 */
type Lineage = {
	seq: number;
	/** `memory:<id>` of the versions a correction replaced. */
	review: Set<string>;
	/** `memory:<id>` of a version a consolidation replaced, to the version that took its place. */
	renamed: Map<string, string>;
};
const lineages = new WeakMap<object, Lineage>();

/** What the memory's change feed says of the versions replaced since the beginning, read incrementally. */
function lineageOf(deps: AgencyHostDeps, db: Database): Lineage {
	const seen = lineages.get(deps) ?? {
		seq: 0,
		review: new Set<string>(),
		renamed: new Map<string, string>(),
	};
	lineages.set(deps, seen);
	const feed = deps.memory.referenceInputs;
	if (!feed) return seen;
	// A feed that cannot be read fails the call: what was corrected must not be taken for current.
	for (;;) {
		const page = feed.changesInTransaction(db, seen.seq);
		for (const change of page.changes) {
			if (change.targetType !== "state_item") continue;
			if (change.changeKind === "correction")
				seen.review.add(`memory:${change.targetId}`);
			else if (change.changeKind === "consolidation" && change.successorId)
				seen.renamed.set(
					`memory:${change.targetId}`,
					`memory:${change.successorId}`,
				);
		}
		seen.seq = Math.max(seen.seq, page.nextAfterSeq);
		if (!page.hasMore) break;
	}
	return seen;
}

/**
 * The memory items whose version was replaced by a correction (the change feed's `correction`), as `memory:<id>`:
 * what the agent holds on them is under review until the host lets it go.
 */
export const reviewRefs = (deps: AgencyHostDeps, db: Database) =>
	lineageOf(deps, db).review;

/**
 * The version a `memory:<id>` reference stands for now: a version a consolidation replaced (its meaning is the same)
 * is the one that took its place, through any number of consolidations. Anything else stands for itself.
 */
export function currentRef(
	deps: AgencyHostDeps,
	db: Database,
	ref: string,
): string {
	if (!ref.startsWith("memory:")) return ref;
	const { renamed } = lineageOf(deps, db);
	let now = ref;
	for (let hops = 0; hops < 32 && renamed.has(now); hops++)
		now = renamed.get(now)!;
	return now;
}

/** The marks read in the burst of calls that is running now (the package asks for them at every choice). */
const burst = new WeakMap<object, AgendaMarks>();

/**
 * The marks on the host's records, for what the scope's agent holds now:
 * - under review: the corrected versions (the change feed's `correction`) that an item of the agent cites, and the
 *   plans that stand on one (`plan:<id>`); an item made again on the current version is no longer cited, and goes;
 * - suppressed: a fact (its records), or a topic word.
 * A read that fails fails the call (the package's step fails), and nothing is let through. The read is made once for
 * the synchronous run of choices that asks for it again and again (the next one, after an await, reads anew).
 */
export function marksFor(
	deps: AgencyHostDeps,
	c: Pick<AgendaScope, "agent">,
): AgendaMarks {
	const status = deps.memory.status();
	if (!status.enabled || !status.healthy) return {};
	const held = burst.get(c);
	if (held) return held;
	const cited = new Set(
		c.agent
			.view()
			.items.flatMap((item) => item.refs)
			.filter((ref) => ref.startsWith("memory:")),
	);
	const marks = deps.store.read((db): AgendaMarks => {
		const suppression = deps.memory.suppressionsInTransaction(db);
		const facts = new Set(
			suppression.facts.map((f) => `${f.kind}\u0000${f.semanticKey}`),
		);
		const review = reviewRefs(deps, db);
		return {
			underReview: [
				...[...cited].filter((ref) => review.has(ref)),
				...deps.continuity.plans
					.listInTransaction(db)
					.filter((p) =>
						p.memoryItemIds.some((id) => review.has(`memory:${id}`)),
					)
					.flatMap((p) => {
						const kind = planReferenceKind(p);
						return [`${kind}:${p.id}`, `${kind}:${planReference(p)}`];
					}),
			],
			suppressedRefs: facts.size
				? deps.memory
						.list(true)
						.filter((item) =>
							facts.has(`${item.kind}\u0000${item.semanticKey}`),
						)
						.map((item) => `memory:${item.id}`)
				: [],
			suppressedTopics: suppression.terms,
		};
	});
	burst.set(c, marks);
	queueMicrotask(() => burst.delete(c));
	return marks;
}

/** The `memory:<id>` references the agent gives no reply or speech: under review or suppressed. */
export function heldMemoryRefs(
	deps: AgencyHostDeps,
	c: Pick<AgendaScope, "agent">,
): Set<string> {
	const marks = marksFor(deps, c);
	return new Set([
		...(marks.underReview ?? []),
		...(marks.suppressedRefs ?? []),
	]);
}

/** What a call is given of `c`'s talk, for the host's selections. */
export const saidOf = (c: Pick<AgendaScope, "agent">): string[] =>
	c.agent.view().said.map((s) => s.text);
