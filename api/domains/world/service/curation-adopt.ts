import type { Database } from "bun:sqlite";
import type { SourceRef } from "eumenes-memory";
import {
	planAssertionTransition,
	type Assertion,
	type Origin,
	type ProjectionEntry,
	type ScopeRef,
	type TransitionPlan,
	type TransitionRequest,
} from "eumenes-world-model";
import { CurationError, type CurationCtx } from "./curation-ctx";

type Head = {
	id: string;
	revision: number;
	lifecycle: Assertion["lifecycle"];
	origin: Origin;
};

/** A refusal that only means "the claim is not what it was": the element is dropped, nothing is undone. */
export type SoftRefusal = { rejected: string };

/**
 * Adoption, correction and retraction of claims as internal operations of the steward's
 * curation (steward plan section 3.3). They run in the caller's transaction and never answer
 * for a person: the person's own statement is the adoption.
 */
export function createAdoption(ctx: CurationCtx) {
	const { world, purpose, now } = ctx;

	function plan(
		scope: ScopeRef,
		head: Head,
		request: TransitionRequest,
	): { plan: TransitionPlan } | SoftRefusal {
		const planned = planAssertionTransition({
			contractVersion: 1,
			scope,
			current: {
				id: head.id,
				revision: head.revision,
				scope,
				lifecycle: head.lifecycle,
				origin: head.origin,
			},
			expectedRevision: head.revision,
			request,
			registeredAdoptionRules: [],
		});
		if (!planned.ok)
			throw new CurationError(`transition_invalid_${planned.code}`);
		if (planned.value.status !== "planned")
			return { rejected: planned.value.reasonCode };
		return { plan: planned.value.plan };
	}

	function apply(
		db: Database,
		scope: ScopeRef,
		operationKey: string,
		operation: Record<string, unknown>,
	): void {
		const result = world.applyInWriter(db, {
			access: {
				principal: scope.principal,
				scopeKeys: [scope.scopeKey],
				purpose,
			},
			scope,
			operationKey,
			clock: now(),
			operation: operation as never,
		});
		if (result.status !== "applied" && result.status !== "no_op")
			throw new CurationError(
				`transition_refused_${"reasonCode" in result ? result.reasonCode : result.status}`,
			);
	}

	/** The explicit adoption a person's (or, for a hypothesis, the answer's) statement stands for. */
	function adoptionRequest(operationId: string): TransitionRequest {
		return {
			action: "adopt",
			adoption: { kind: "explicit", operationId },
			subjectConfirmedByHost: true,
		};
	}

	/** A just registered candidate becomes adopted. A refusal here is a fault: it rolls back. */
	function adopt(
		db: Database,
		scope: ScopeRef,
		key: string,
		head: { id: string; revision: number; origin: Origin },
	): void {
		const planned = plan(
			scope,
			{ ...head, lifecycle: "candidate" },
			adoptionRequest(`${key}-adopt`),
		);
		if ("rejected" in planned)
			throw new CurationError(`adopt_${planned.rejected.toLowerCase()}`);
		apply(db, scope, `${key}-adopt`, {
			kind: "assertion.transition",
			plan: planned.plan,
		});
	}

	return {
		adopt,
		/**
		 * A newer statement replaces a claim's value: supersede with the replacement revision, then
		 * adopt it. Soft refusal when the claim moved or ended meanwhile.
		 */
		correct(
			db: Database,
			scope: ScopeRef,
			key: string,
			old: ProjectionEntry,
			replacement: Assertion,
		): SoftRefusal | null {
			const supersede = plan(
				scope,
				{
					id: old.id,
					revision: old.revision,
					lifecycle: old.assertion.lifecycle,
					origin: old.origin,
				},
				{ action: "supersede", replacementRevision: replacement.revision },
			);
			if ("rejected" in supersede) return supersede;
			apply(db, scope, `${key}-supersede`, {
				kind: "assertion.transition",
				plan: supersede.plan,
				replacement,
			});
			adopt(db, scope, key, {
				id: replacement.id,
				revision: replacement.revision,
				origin: replacement.origin,
			});
			return null;
		},

		/** The person says the claim is wrong. Soft refusal when the claim moved or ended meanwhile. */
		retract(
			db: Database,
			scope: ScopeRef,
			key: string,
			old: ProjectionEntry,
			reasonSource: SourceRef,
		): SoftRefusal | null {
			const planned = plan(
				scope,
				{
					id: old.id,
					revision: old.revision,
					lifecycle: old.assertion.lifecycle,
					origin: old.origin,
				},
				{ action: "retract", reasonSource },
			);
			if ("rejected" in planned) return planned;
			apply(db, scope, key, {
				kind: "assertion.transition",
				plan: planned.plan,
			});
			return null;
		},
	};
}
export type Adoption = ReturnType<typeof createAdoption>;
