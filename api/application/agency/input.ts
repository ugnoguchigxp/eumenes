import type { InputContext } from "eumenes-agency";
import type { AgencyHostDeps } from "./host-types";
import type { Database } from "bun:sqlite";
import { sha256Hex } from "../../infrastructure/digest";
import { currentRef } from "./always-on-recall";
import { touchesSuppressedTerm } from "../../domains/memory";
import { PRINCIPAL, PROFILE_SCOPE } from "../../domains/memory/contracts";
import {
	parseRecordReference,
	planReferenceKind,
	recordReferencePattern,
} from "./plan-reference";

export const recordPrefix = "agency-record:";
export type AgencyRecordInputDeps = Pick<
	AgencyHostDeps,
	"continuity" | "conversation"
> & {
	agendaGoals?: Pick<
		NonNullable<AgencyHostDeps["agendaGoals"]>,
		"store" | "sourceMessageIds"
	>;
	memory: Pick<AgencyHostDeps["memory"], "suppressionsInTransaction">;
};
function recordInput(
	deps: AgencyRecordInputDeps,
	db: Database,
	prefix: "goal" | "plan" | "conflict",
	id: string,
	revision?: number,
) {
	const alive = (text: string) =>
		!touchesSuppressedTerm(
			deps.memory.suppressionsInTransaction(db).terms,
			text,
		);
	if (prefix === "goal") {
		const goals = deps.agendaGoals;
		const access = { principal: PRINCIPAL, scopeKeys: [PROFILE_SCOPE] };
		const goal = goals?.store.currentGoalInTransaction(db, access, id);
		const ids = goals?.sourceMessageIds?.(db, id);
		if (
			!goal ||
			goal.status !== "adopted" ||
			(revision !== undefined && goal.revision !== revision) ||
			!ids?.length ||
			!alive(goal.desiredState)
		)
			return null;
		return {
			messages: ids,
			items: [],
			stamp: [prefix, id, goal.revision, goal.scopeKey],
		};
	}
	const plan = deps.continuity.plans.getInTransaction(db, id);
	if (
		!plan ||
		plan.state === "closed" ||
		(revision !== undefined && plan.revision !== revision) ||
		planReferenceKind(plan) !== prefix ||
		!(plan.evidence.length || plan.memoryItemIds.length) ||
		!alive(plan.text)
	)
		return null;
	for (const evidence of plan.evidence) {
		const source = deps.conversation.sourceInTransaction(
			db,
			evidence.messageId,
		);
		if (
			source.state !== "available" ||
			source.message.conversationId !== evidence.conversationId
		)
			return null;
	}
	return {
		messages: plan.evidence.map(({ messageId }) => messageId),
		items: plan.memoryItemIds,
		stamp: [prefix, id, plan.revision, plan.conversationId],
	};
}

export function staleRecordInputs(
	deps: AgencyRecordInputDeps,
	db: Database,
	sources: readonly string[],
) {
	return sources.filter((source) => {
		if (!source.startsWith(recordPrefix)) return false;
		try {
			const raw: unknown = JSON.parse(source.slice(recordPrefix.length));
			if (!Array.isArray(raw)) return true;
			const [kind, id] = raw;
			if (
				(kind !== "goal" && kind !== "plan" && kind !== "conflict") ||
				typeof id !== "string"
			)
				return true;
			const current = recordInput(deps, db, kind, id);
			return (
				!current || source !== recordPrefix + JSON.stringify(current.stamp)
			);
		} catch {
			return true;
		}
	});
}

export const fixedInput = (value: unknown): InputContext => ({
	sources: [`host-config:${sha256Hex(JSON.stringify(value))}`],
	complete: true,
});
export function staleInputSources(
	deps: AgencyHostDeps,
	db: Database,
	sources: readonly string[],
): string[] {
	return [
		...(deps.memory.referenceInputs?.staleInTransaction(db, sources) ?? []),
		...(deps.state?.staleSourcesInTransaction(db, sources) ?? []),
		...staleRecordInputs(deps, db, sources),
	];
}

/**
 * The plain `memory:<id>` references whose item is no longer current (superseded, deactivated, expired). A reply that
 * cites one is refused at adoption (`referencedInput`), so the agenda lets go of what rests on it as well.
 */
export function staleMemoryRefs(
	deps: AgencyHostDeps,
	db: Database,
	sources: readonly string[],
): string[] {
	const refs = [...new Set(sources.filter((r) => r.startsWith("memory:")))];
	if (!refs.length || !deps.memory.referenceInputs) return [];
	const status = deps.memory.status();
	if (!status.enabled || !status.healthy) return [];
	// A version a consolidation replaced is its successor (the same meaning): that is what has to be current.
	const now = new Map(refs.map((r) => [r, currentRef(deps, db, r)]));
	const current = new Set(
		deps.memory.referenceInputs.captureInTransaction(db, {
			itemIds: [...new Set(now.values())].map((r) => r.slice("memory:".length)),
		}).sources,
	);
	return refs.filter((r) => !current.has(now.get(r)!));
}
export function currentInput(
	deps: AgencyHostDeps,
	db: Database,
	input: InputContext,
): boolean {
	return (
		input.complete &&
		(!deps.memory.referenceInputs ||
			deps.memory.referenceInputs.isCurrentInTransaction(db, input)) &&
		!deps.state?.staleSourcesInTransaction(db, input.sources).length &&
		!staleRecordInputs(deps, db, input.sources).length
	);
}

/**
 * The sources behind what the agenda agent cites, stamped by their owners. A note rests on what it was made from.
 */
export function resolveReferences(
	deps: AgencyHostDeps,
	db: Database,
	notes: readonly {
		id: string;
		refs: readonly string[];
		inputs?: readonly string[];
	}[],
	refs: readonly string[],
) {
	const messageIds = new Set<string>();
	const itemIds = new Set<string>();
	const retained: string[] = [];
	let reason:
		"agency_reference_stale" | "agency_reference_unsupported" | undefined;
	const seen = new Set<string>();
	const visit = (ref: string) => {
		const base = currentRef(deps, db, ref.replace(/:c\d+$/u, ""));
		if (seen.has(base)) return;
		seen.add(base);
		if (base.startsWith("memory:")) itemIds.add(base.slice("memory:".length));
		else if (base.startsWith("note:")) {
			const note = notes.find((n) => n.id === base.slice("note:".length));
			if (note?.inputs) {
				retained.push(...note.inputs);
				if (!currentInput(deps, db, { sources: note.inputs, complete: true }))
					reason ??= "agency_reference_stale";
			} else if (note) note.refs.forEach(visit);
			else reason ??= "agency_reference_stale";
		} else if (recordReferencePattern.test(base)) {
			const ref = parseRecordReference(base);
			if (!ref) {
				reason ??= "agency_reference_unsupported";
				return;
			}
			const record = recordInput(deps, db, ref.kind, ref.id, ref.revision);
			if (!record) {
				reason ??= "agency_reference_stale";
				return;
			}
			for (const id of record.messages) {
				const source = deps.conversation.sourceInTransaction(db, id);
				if (
					source.state !== "available" ||
					deps.memory.isBlockedInTransaction?.(db, id)
				) {
					reason ??= "agency_reference_stale";
					continue;
				}
				messageIds.add(id);
			}
			record.items.forEach((id) => itemIds.add(id));
			retained.push(recordPrefix + JSON.stringify(record.stamp));
		} else if (!base.startsWith("profile:")) messageIds.add(base);
	};
	refs.forEach(visit);
	const captured = deps.memory.referenceInputs?.captureInTransaction(db, {
		messageIds: [...messageIds],
		itemIds: [...itemIds],
	});
	if (captured?.complete === false) reason ??= "agency_reference_stale";
	if (!captured && itemIds.size) reason ??= "agency_reference_unsupported";
	return {
		input: {
			sources: [
				...new Set([...(captured?.sources ?? messageIds), ...retained]),
			],
			complete: reason === undefined,
		},
		reason,
	};
}

export function referencedInput(
	...args: Parameters<typeof resolveReferences>
): InputContext {
	return resolveReferences(...args).input;
}
