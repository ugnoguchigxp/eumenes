import type { Database } from "bun:sqlite";
import {
	CLOSED_PLAN_RETENTION_MS,
	MAX_OPEN_PLANS,
	MAX_OPEN_PLANS_PER_CONVERSATION,
	PLAN_TEXT_MAX,
	planKinds,
	planStates,
	type EvidenceInput,
	type PlanItem,
	type PlanKind,
	type PlanState,
} from "../contracts/plans";
import {
	addEvidence,
	changePlan,
	countOpenPlans,
	getPlan,
	insertPlan,
	listPlans,
	markPlansOverdue,
	pruneClosedPlans,
	searchPlans,
} from "../repository/plans";
import {
	checkDue,
	checkText,
	cut,
	localDue,
	normalizeEvidence,
	type Visible,
} from "./evidence";

const LOCAL_NOW = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u;
/** The open states: shown to the context and counted toward the limits. */
const OPEN_STATES: readonly PlanState[] = ["open", "awaiting_confirmation"];

export interface PlanQuery {
	/** Plans of one conversation; every conversation when left out. */
	conversationId?: string;
	kinds?: readonly PlanKind[];
	/** Default: open and awaiting confirmation. */
	states?: readonly PlanState[];
	/** The caller's cut (items or tokens); nothing is cut when left out. */
	limit?: number;
}

/** Plans with a date (L3). Every write comes with evidence and is made in the caller's transaction. */
export function createPlans(
	clock: () => string,
	id: () => string,
	visible: Visible,
) {
	const states = (wanted: readonly PlanState[] | undefined) => {
		const list = wanted ?? OPEN_STATES;
		if (list.length === 0 || list.some((s) => !planStates.includes(s)))
			throw new Error("invalid_plan_state");
		return list;
	};
	return {
		/**
		 * Adds a plan, intent, open question or decision. Throws `invalid_plan_text`, `invalid_plan_due`,
		 * `invalid_continuity_evidence` or `invalid_plan_limit` (per conversation and over all conversations).
		 */
		addInTransaction(
			db: Database,
			input: {
				conversationId: string;
				kind: PlanKind;
				text: string;
				dueAt?: string | null;
				evidence: EvidenceInput;
			},
		): PlanItem {
			if (!planKinds.includes(input.kind) || input.conversationId === "")
				throw new Error("invalid_plan_kind");
			const text = checkText(input.text, PLAN_TEXT_MAX);
			checkDue(input.dueAt);
			const evidence = normalizeEvidence(input.evidence);
			if (
				countOpenPlans(db, input.conversationId) >=
					MAX_OPEN_PLANS_PER_CONVERSATION ||
				countOpenPlans(db) >= MAX_OPEN_PLANS
			)
				throw new Error("invalid_plan_limit");
			const now = clock();
			const planId = id();
			insertPlan(db, {
				id: planId,
				conversationId: input.conversationId,
				kind: input.kind,
				text,
				dueAt: localDue(input.dueAt) ?? null,
				state: "open",
				revision: 1,
				createdAt: now,
				lastTouchedAt: now,
				evidence: [],
				memoryItemIds: [],
			});
			addEvidence(db, "plan", planId, input.conversationId, evidence);
			return getPlan(db, planId) as PlanItem;
		},
		/**
		 * Changes the text and/or date of a plan that is not closed (`dueAt` null clears the date, undefined
		 * keeps it) and adds the evidence. The plan is open again, whatever it was waiting for. null when it
		 * is gone, closed, or at another revision.
		 */
		updateInTransaction(
			db: Database,
			planId: string,
			input: {
				text?: string;
				dueAt?: string | null;
				evidence: EvidenceInput;
				expectedRevision?: number;
			},
		): PlanItem | null {
			if (input.text === undefined && input.dueAt === undefined)
				throw new Error("invalid_plan_update");
			const text =
				input.text === undefined
					? undefined
					: checkText(input.text, PLAN_TEXT_MAX);
			checkDue(input.dueAt);
			const evidence = normalizeEvidence(input.evidence);
			const existing = getPlan(db, planId);
			if (!existing) return null;
			if (
				!changePlan(db, planId, input.expectedRevision, {
					...(text === undefined ? {} : { text }),
					...(input.dueAt === undefined
						? {}
						: { dueAt: localDue(input.dueAt) }),
					state: "open",
					touchedAt: clock(),
				})
			)
				return null;
			addEvidence(db, "plan", planId, existing.conversationId, evidence);
			return getPlan(db, planId);
		},
		/** Closes a plan that is not closed (done or given up) with the evidence; null when it cannot. */
		closeInTransaction(
			db: Database,
			planId: string,
			input: { evidence: EvidenceInput; expectedRevision?: number },
		): PlanItem | null {
			const evidence = normalizeEvidence(input.evidence);
			const existing = getPlan(db, planId);
			if (!existing) return null;
			if (
				!changePlan(db, planId, input.expectedRevision, {
					state: "closed",
					touchedAt: clock(),
				})
			)
				return null;
			addEvidence(db, "plan", planId, existing.conversationId, evidence);
			return getPlan(db, planId);
		},
		/**
		 * The sleep layer: open plans whose date has passed wait for the user's confirmation. `localNow` is the
		 * user's local time as `YYYY-MM-DDTHH:MM`. Returns the ids moved.
		 */
		markDueAwaitingInTransaction(db: Database, localNow: string): string[] {
			if (!LOCAL_NOW.test(localNow)) throw new Error("invalid_plan_due");
			return markPlansOverdue(db, localNow);
		},
		/** Soonest date first, then plans without a date by the latest touch. */
		listInTransaction(db: Database, query: PlanQuery = {}): PlanItem[] {
			return cut(
				visible(
					db,
					listPlans(db, {
						...(query.conversationId === undefined
							? {}
							: { conversationId: query.conversationId }),
						...(query.kinds ? { kinds: query.kinds } : {}),
						states: states(query.states),
					}),
				),
				query.limit,
			);
		},
		/** Full-text search over the texts (best match first). */
		searchInTransaction(
			db: Database,
			text: string,
			query: Pick<PlanQuery, "conversationId" | "states" | "limit"> = {},
		): PlanItem[] {
			return cut(
				visible(
					db,
					searchPlans(db, text, {
						...(query.conversationId === undefined
							? {}
							: { conversationId: query.conversationId }),
						states: states(query.states),
					}),
				),
				query.limit,
			);
		},
		/** One plan by id (any state); null when unknown or resting on an excluded source. */
		getInTransaction(db: Database, planId: string): PlanItem | null {
			const plan = getPlan(db, planId);
			return plan ? (visible(db, [plan])[0] ?? null) : null;
		},
		/** Deletes closed plans untouched for the retention time; returns the count. */
		pruneClosedInTransaction(db: Database): number {
			return pruneClosedPlans(
				db,
				new Date(Date.parse(clock()) - CLOSED_PLAN_RETENTION_MS).toISOString(),
			);
		},
	};
}
