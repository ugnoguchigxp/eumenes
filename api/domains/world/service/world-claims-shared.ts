import type {
	Assertion,
	CanonicalHasher,
	Condition,
	ConditionSpec,
	ProjectionEntry,
} from "eumenes-world-model";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import {
	claimTone,
	type ClaimAdoption,
	type ClaimContent,
	type ClaimEvidenceKind,
	type ClaimRow,
	type EvidenceView,
	type ForgetDisplay,
	type ForgetView,
	type WorldClaimError,
} from "../contracts/claims";
import type { ForgetListItem, WorldLifecycle } from "./lifecycle-adapter";
import type { WorldService } from "./world-service";

/** Who is asking. Built by trusted host code, never by a request body. */
export type WorldClaimsContext = {
	principal: string;
	/** The Scopes this caller may use. Anything else looks like "not found". */
	scopeKeys: readonly string[];
};

export type WorldClaimsOptions = {
	store: SqliteStore;
	world: WorldService;
	lifecycle: WorldLifecycle;
	/** Host mode and gate (the assembly knows them; World's tables do not). */
	state: () => { mode: "protect" | "on"; gateOpen: boolean };
	/** UTC epoch ms. World never reads a clock itself. Default Date.now. */
	now?: () => number;
	/** AccessContext purposes (the host's SourceAdapters must allow them). */
	readPurpose: string;
	hasher?: CanonicalHasher;
};

/** What a call can answer besides its data. Access refusals are all `not_found`. */
export type ClaimFailure = { status: "failed"; code: WorldClaimError };
export type ClaimResult<T> = { status: "ok"; value: T } | ClaimFailure;

export const fail = (code: WorldClaimError): ClaimFailure => ({
	status: "failed",
	code,
});
export const ok = <T>(value: T): ClaimResult<T> => ({ status: "ok", value });

/** One bounded snapshot of a Scope: the projection and what it stands on. */
export type ScopeRead = {
	entries: readonly ProjectionEntry[];
	assertions: readonly Assertion[];
	sources: readonly {
		namespace: string;
		kind: string;
		id: string;
		representation?: string;
		revision: string;
		status: string;
	}[];
	complete: boolean;
	stopped: number;
	asOf: number;
};

export const FORGET_LIMIT = 50;

export const adoptionOf = (status: ProjectionEntry["status"]): ClaimAdoption =>
	status === "active" ? "adopted" : status;

export function contentOf(assertion: Assertion): ClaimContent {
	const payload = assertion.payload;
	return payload.kind === "relation"
		? {
				kind: "relation",
				relation: payload.relation,
				objectId: payload.objectId,
			}
		: { kind: "value", value: payload.value };
}

function evidenceKindsOf(assertion: Assertion): ClaimEvidenceKind[] {
	return [...new Set(assertion.evidence.map((e) => e.kind))].sort();
}

export function rowOf(entry: ProjectionEntry): ClaimRow {
	const adoption = adoptionOf(entry.status);
	const evidenceKinds = evidenceKindsOf(entry.assertion);
	return {
		id: entry.id,
		revision: entry.revision,
		target: { subjectId: entry.subjectId },
		claim: { predicate: entry.predicate, content: contentOf(entry.assertion) },
		adoption,
		origin: entry.origin,
		evidenceKinds,
		freshness: entry.freshness,
		tone: claimTone(adoption, entry.origin, evidenceKinds),
	};
}

export const byClaim = (a: ClaimRow, b: ClaimRow) =>
	a.target.subjectId.localeCompare(b.target.subjectId) ||
	a.claim.predicate.localeCompare(b.claim.predicate) ||
	a.id.localeCompare(b.id);

export const evidenceViews = (assertion: Assertion): EvidenceView[] =>
	assertion.evidence.map((e) => ({
		evidenceId: e.evidenceId,
		kind: e.kind,
		stance: e.stance,
		source: {
			namespace: e.source.namespace,
			kind: e.source.kind,
			id: e.source.id,
			revision: e.source.revision,
		},
		rootEvidenceId: e.rootEvidenceId,
		...(e.seriesId === undefined ? {} : { seriesId: e.seriesId }),
	}));

const valueText = (value: unknown): string => {
	const v = value as {
		kind: string;
		value?: unknown;
		unit?: string;
		entityId?: string;
	};
	if (v.kind === "entity") return `対象:${v.entityId}`;
	if (v.kind === "number") return `${String(v.value)} ${v.unit ?? ""}`.trim();
	return JSON.stringify(v.value);
};
const OPS = {
	eq: "=",
	ne: "≠",
	lt: "<",
	lte: "≤",
	gt: ">",
	gte: "≥",
} as const;
/** A bounded plain-text form of a condition (no evaluation). */
export function conditionText(spec: ConditionSpec): string {
	if (spec.kind === "unspecified") return "条件は記述されていません";
	if (spec.kind === "explicitly_unconditional") return "無条件（明示）";
	const walk = (c: Condition): string => {
		switch (c.kind) {
			case "compare":
				return `${c.key} ${OPS[c.op as keyof typeof OPS] ?? c.op} ${valueText(c.value)}`;
			case "all":
				return `(${c.items.map(walk).join(" かつ ")})`;
			case "any":
				return `(${c.items.map(walk).join(" または ")})`;
			case "not":
				return `ではない(${walk(c.item)})`;
			default:
				return "表現できない条件";
		}
	};
	return walk(spec.expression);
}

export function forgetView(item: ForgetListItem): ForgetView {
	const abandoned = item.abandoned.parts > 0 || item.abandoned.roots > 0;
	const display: ForgetDisplay = abandoned
		? "abandoned"
		: item.complete
			? "complete"
			: item.state === "world_applied" || item.state === "memory_confirmed"
				? "awaiting_confirmation"
				: "pending";
	return {
		forgetId: item.forgetId,
		display,
		state: item.state,
		blocked: item.blocked,
		abandoned: item.abandoned,
		origin: item.origin,
		rootCount: item.rootCount,
		createdAt: item.createdAt,
		updatedAt: item.updatedAt,
	};
}
