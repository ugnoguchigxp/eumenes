import type { Database } from "bun:sqlite";
import type { SourceRef } from "eumenes-memory";
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
import type { WorldApplyResult } from "../contracts";
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
	/**
	 * The CURRENT source of a confirmed message of the person, or null (unknown,
	 * not theirs, not confirmed, retracted: one answer). Evaluated on the
	 * writer connection of the change.
	 */
	reasonSource: (db: Database, messageId: string) => SourceRef | null;
	/** UTC epoch ms. World never reads a clock itself. Default Date.now. */
	now?: () => number;
	/** AccessContext purposes (the host's SourceAdapters must allow them). */
	readPurpose: string;
	writePurpose: string;
	hasher?: CanonicalHasher;
	/** Told (never the person) when a forget stopped while advancing; it stays pending and is resumed. */
	onForgetAdvanceFailed?: (error: unknown) => void;
};

/** What a call can answer besides its data. Access refusals are all `not_found`. */
export type ClaimFailure =
	| { status: "failed"; code: WorldClaimError }
	/** A request that wrote nothing and needs a person's choice. */
	| { status: "failed"; code: "revision_conflict"; reload: true };
export type ClaimResult<T> = { status: "ok"; value: T } | ClaimFailure;

export const fail = (code: WorldClaimError): ClaimFailure =>
	code === "revision_conflict"
		? { status: "failed", code, reload: true }
		: { status: "failed", code };
export const ok = <T>(value: T): ClaimResult<T> => ({ status: "ok", value });

/** Thrown inside a writer callback to roll everything back and answer. */
export class Abort extends Error {
	constructor(readonly failure: ClaimFailure) {
		super("world_claims_abort");
	}
}

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

export type Target =
	| { claimId: string }
	| { subjectId: string; predicate: string };
export type Located =
	| { kind: "one"; entry: ProjectionEntry }
	| { kind: "none" }
	| { kind: "many"; entries: ProjectionEntry[] };
export function locate(
	entries: readonly ProjectionEntry[],
	target: Target,
): Located {
	const found =
		"claimId" in target
			? entries.filter((e) => e.id === target.claimId)
			: entries.filter(
					(e) =>
						e.subjectId === target.subjectId &&
						e.predicate === target.predicate,
				);
	if (found.length === 0) return { kind: "none" };
	if (found.length === 1) return { kind: "one", entry: found[0]! };
	return { kind: "many", entries: found };
}

/** Maps a refusal of World / the host to the one error vocabulary. */
export function failureOf(result: WorldApplyResult): ClaimFailure {
	if (!("reasonCode" in result)) return fail("invalid_world_request");
	switch (result.reasonCode) {
		case "REVISION_CONFLICT":
		case "STALE_REVISION":
			return fail("revision_conflict");
		case "WORLD_DISABLED":
			return fail("world_disabled");
		case "WORLD_RECOVERY_REQUIRED":
		case "WRITER_BUSY":
		case "STORE_CLOSING":
		case "MEMORY_UNAVAILABLE":
		case "SCHEMA_INCOMPATIBLE":
			return fail("world_unavailable");
		case "SOURCE_NOT_AVAILABLE":
		case "SOURCE_VERSION_MISMATCH":
		case "MEMORY_TOMBSTONED":
			return fail("reason_source_unavailable");
		case "TERMINAL_STATE":
		case "TRANSITION_NOT_ALLOWED":
			return fail("claim_not_changeable");
		case "SCOPE_NOT_PERMITTED":
		case "SCOPE_MISMATCH":
		case "POLICY_CHANGED":
		case "TOMBSTONED":
		case "GATE_CLOSED":
		case "MEMORY_SCOPE_NOT_PERMITTED":
			return fail("not_found");
		default:
			return fail("invalid_world_request");
	}
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
