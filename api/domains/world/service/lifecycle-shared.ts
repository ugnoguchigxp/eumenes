import { sha256Hex } from "../../../infrastructure/digest";
import { MemoryStoreError } from "eumenes-memory/sqlite";
import {
	checkOpaque,
	checkRevision,
	isWellFormed,
	type ScopeRef,
} from "eumenes-world-model";
import { WriterBusyError } from "../../../infrastructure/sqlite";
import { type WorldApplyResult } from "../contracts";
import {
	ROOT_KINDS,
	type ForgetRoot,
	type IntakeRow,
} from "../repository/lifecycle";
import { sourceKeyOf } from "./inputs";
import { WorldJournalCorruptError } from "./world-journal";
import type { ForgetRefusal, ForgetRequest } from "./lifecycle-types";

export const MAX_CHUNK_ROOTS = 500;
export const MAX_ROOTS_PER_FORGET = 50_000;
export const MAX_REGISTRATIONS = 200;
export const MAX_TOMBSTONES = 200;
export const FEED_PAGE = 500;
export const FEED_MAX_ROWS = 5000;
export const INVALIDATE_KEYS = 20;
export const MAX_ID_BYTES = 200;
/** Splits a forget id from its part number; reserved, so a caller id may not contain it. */
export const PART_SEPARATOR = "~";
export const DEFAULT_DEPENDENT_PAGE = 100;

export const short = (text: string) => sha256Hex(text).slice(0, 24);
export const utf8 = (text: string) => new TextEncoder().encode(text).length;

export class StepBlocked extends Error {
	constructor(readonly reason: string) {
		super(`world_lifecycle_${reason.toLowerCase()}`);
	}
}

export const memoryUnavailable = (error: unknown): boolean =>
	error instanceof MemoryStoreError;
export const transientReason = (error: unknown): string | null => {
	if (error instanceof WriterBusyError) return "WRITER_BUSY";
	if (error instanceof Error && error.message === "database_closing")
		return "STORE_CLOSING";
	if (memoryUnavailable(error)) return "MEMORY_UNAVAILABLE";
	if (error instanceof StepBlocked) return error.reason;
	if (error instanceof WorldJournalCorruptError) return "JOURNAL_CORRUPT";
	return null;
};

export const rootDigest = (roots: readonly ForgetRoot[]): string =>
	sha256Hex(
		JSON.stringify(
			[...roots]
				.map((r) => [r.kind, r.id, r.revision] as const)
				.sort((a, b) =>
					a[0] === b[0]
						? a[1] === b[1]
							? a[2] - b[2]
							: a[1] < b[1]
								? -1
								: 1
						: a[0] < b[0]
							? -1
							: 1,
				),
		),
	);

/**
 * The stored roots of an intake are the requested ones, plus `candidate` roots
 * the host added for extraction events (P4-01). Used to recognise a resend.
 */
export function rootsCover(
	existing: Pick<IntakeRow, "roots">,
	requested: readonly ForgetRoot[],
): boolean {
	return (
		requested.every((r) =>
			existing.roots.some(
				(x) => x.kind === r.kind && x.id === r.id && x.revision === r.revision,
			),
		) &&
		existing.roots.every(
			(x) =>
				x.kind === "candidate" ||
				x.kind === "outcome" ||
				requested.some((r) => r.kind === x.kind && r.id === x.id),
		)
	);
}

/**
 * The same id rules World applies to a forget root (`checkTargetRef`): the
 * kind is known, source/state ids may be 8192 bytes, every other kind 256,
 * ids are non-empty and well-formed (no lone surrogates), revision >= 1.
 */
export function isValidRoot(root: {
	kind: unknown;
	id: unknown;
	revision?: unknown;
}): boolean {
	if (!(ROOT_KINDS as readonly string[]).includes(root.kind as string))
		return false;
	const long = root.kind === "source" || root.kind === "state";
	return (
		checkOpaque(root.id, "id", long ? 8192 : 256).ok &&
		checkRevision(root.revision ?? 1, "revision").ok
	);
}

/** Well-formed id of a forget; the part separator is reserved. */
export const validForgetId = (id: unknown, allowSeparator: boolean): boolean =>
	typeof id === "string" &&
	id !== "" &&
	isWellFormed(id) &&
	utf8(id) <= MAX_ID_BYTES &&
	(allowSeparator || !id.includes(PART_SEPARATOR));

export function normalizeRoots(
	roots: ForgetRequest["roots"],
): ForgetRoot[] | ForgetRefusal {
	if (roots.length === 0)
		return { status: "rejected", reasonCode: "INVALID_INPUT" };
	if (roots.length > MAX_ROOTS_PER_FORGET)
		return { status: "rejected", reasonCode: "TOO_MANY_ROOTS" };
	const seen = new Set<string>();
	const out: ForgetRoot[] = [];
	for (const root of roots) {
		if (!isValidRoot(root))
			return { status: "rejected", reasonCode: "INVALID_INPUT" };
		const revision = root.revision ?? 1;
		const slot = JSON.stringify([root.kind, root.id, revision]);
		if (seen.has(slot)) continue;
		seen.add(slot);
		out.push({ kind: root.kind, id: root.id, revision });
	}
	return out;
}

/** Feeds: roots that are not valid World ids are counted and skipped, the rest still go. */
export function splitValidRoots<T extends { kind: string; id: string }>(
	roots: readonly T[],
): { valid: T[]; rejected: number } {
	const valid = roots.filter((root) => isValidRoot(root));
	return { valid, rejected: roots.length - valid.length };
}

export const stateItemKey = (itemId: string) =>
	sourceKeyOf({ namespace: "memory", kind: "state_item", id: itemId });
/** Memory's recordSourceKey: namespace memory, kind record, representation text. */
export const recordKey = (recordId: string) =>
	sourceKeyOf({
		namespace: "memory",
		kind: "record",
		id: recordId,
		representation: "text",
	});

/** The reason a World result was not applied. */
export const why = (result: WorldApplyResult): string =>
	"reasonCode" in result ? result.reasonCode : "NOT_APPLIED";

export const chunk = <T>(items: readonly T[], size: number): T[][] => {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size)
		out.push(items.slice(i, i + size));
	return out;
};

export const forgetKey = (forgetId: string, kind: string, n: number | string) =>
	`wl:${short(forgetId)}:${kind}:${n}`;
/**
 * World closes a forget as soon as every root it was GIVEN is erased, so a
 * later chunk of roots for the same id would be refused. More than 500 roots
 * therefore become several World forgets ("parts"): part 0 keeps the id,
 * part n is `<id>~n`. Each part is resumable on its own.
 */
export const partId = (forgetId: string, part: number) =>
	part === 0 ? forgetId : `${forgetId}${PART_SEPARATOR}${part}`;
export const partCount = (row: IntakeRow) =>
	Math.max(1, Math.ceil(row.roots.length / MAX_CHUNK_ROOTS));

/** A Memory forget id may not contain the reserved part separator: such ids are hashed. */
export const feedForgetId = (id: string): string =>
	validForgetId(id, false) ? id : `mf-${short(id)}`;

export function feedKeyOf(
	scope: ScopeRef,
	a: string | number,
	b: string | number,
) {
	return short(`${scope.principal}\u0000${scope.scopeKey}\u0000${a}\u0000${b}`);
}

/** Roots of a Memory notification that says "forgotten". */
export function memoryRoot(change: {
	targetType: string;
	targetId: string;
}): ForgetRoot | null {
	if (change.targetType === "source")
		return { kind: "source", id: change.targetId, revision: 1 };
	if (change.targetType === "state_item")
		return { kind: "state", id: stateItemKey(change.targetId), revision: 1 };
	if (change.targetType === "record")
		return { kind: "source", id: recordKey(change.targetId), revision: 1 };
	return null;
}

export const STOPPED = new Set([
	"inactive",
	"superseded",
	"disputed",
	"retracted",
	"invalidated",
]);
export const scopeOf = (row: IntakeRow): ScopeRef => ({
	principal: row.principal,
	scopeKey: row.scopeKey,
});
