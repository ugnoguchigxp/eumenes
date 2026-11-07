import type { Database } from "bun:sqlite";
import type { AccessContext, RecordOrigin } from "eumenes-memory";
import { CONTRACT_VERSIONS } from "eumenes-memory";
import {
	getForgetReceipt,
	recordExternalDeletion,
	captureRecord,
	readRecord,
	listMemoryChanges,
	registerExternalDependents,
	unregisterExternalDependents,
	type CaptureRecordInput,
	type ReadRecordInput,
	type ExternalDependent,
	type ExternalDependentKey,
} from "eumenes-memory/sqlite";
import type { ConversationService } from "../../conversation";
import type { MemoryItemDto } from "../contracts";
import { PROFILE_SCOPE } from "../contracts";
import { sha256Hex } from "../../../infrastructure/digest";
import { readHostInput, writeHostInput } from "../repository/host-inputs";

/** The actual source versions shown by a host. Bodies remain with their owning store. */
export type ReferenceInput = { sources: readonly string[]; complete: boolean };
type Stamp = {
	kind: "message" | "state";
	id: string;
	revision: string;
	digest: string;
	principal: string;
	scope: string;
	policy: string;
};
const PREFIX = "memory-input:";
const encode = (stamp: Stamp) => PREFIX + JSON.stringify(stamp);
function decode(ref: string): Stamp | null {
	if (!ref.startsWith(PREFIX)) return null;
	const value: unknown = JSON.parse(ref.slice(PREFIX.length));
	if (!value || typeof value !== "object")
		throw new Error("invalid_memory_reference");
	const s = value as Stamp;
	if (
		!["message", "state"].includes(s.kind) ||
		![s.id, s.revision, s.digest, s.principal, s.scope, s.policy].every(
			(v) => typeof v === "string",
		)
	)
		throw new Error("invalid_memory_reference");
	return s;
}

/** Public Memory boundary for host provenance, Records and external dependencies; no Agency state. */
export function createReferenceInputs(deps: {
	access(db: Database, purpose: string): AccessContext;
	healthy(): boolean;
	enabled(db: Database): boolean;
	blocked(db: Database, id: string): boolean;
	conversation: ConversationService;
	items(db: Database): readonly MemoryItemDto[];
	now(): number;
	forgetSeq(db: Database): number;
}) {
	const header = (db: Database) => ({
		contractVersion: 1 as const,
		access: deps.access(db, "host.reference"),
		scopeKey: PROFILE_SCOPE,
	});
	function capture(
		db: Database,
		input: {
			messageIds?: readonly string[];
			itemIds?: readonly string[];
			itemRevisions?: Readonly<Record<string, number>>;
		},
		includeRun = true,
	): ReferenceInput {
		if (!deps.healthy()) throw new Error("memory_unavailable");
		const access = deps.access(db, "host.reference");
		const sources: string[] = [];
		let complete = true;
		for (const id of new Set(input.messageIds ?? [])) {
			const source = deps.conversation.sourceInTransaction(db, id);
			if (source.state !== "available" || deps.blocked(db, id)) {
				complete = false;
				continue;
			}
			sources.push(
				id,
				encode({
					kind: "message",
					id,
					revision: source.revision,
					digest: source.digest,
					principal: source.principal,
					scope: source.scopeKey,
					policy: access.policyRevision,
				}),
			);
			if (includeRun && source.message.role === "assistant") {
				const run = readHostInput(db, source.message.runId ?? `message:${id}`);
				if (run) {
					sources.push(...run.sources);
					complete &&= run.complete;
				} else complete = false;
			}
		}
		const items =
			input.itemIds?.length && deps.enabled(db) ? deps.items(db) : [];
		for (const id of new Set(input.itemIds ?? [])) {
			const item = items.find((i) => i.id === id);
			if (
				!item ||
				(input.itemRevisions?.[id] !== undefined &&
					item.revision !== input.itemRevisions[id]) ||
				item.status !== "active" ||
				(item.validFromMs !== null && item.validFromMs > deps.now()) ||
				(item.validUntilMs !== null && item.validUntilMs <= deps.now())
			) {
				complete = false;
				continue;
			}
			sources.push(
				`memory:${id}`,
				...item.sourceMessageIds,
				encode({
					kind: "state",
					id,
					revision: String(item.revision),
					digest: sha256Hex(JSON.stringify(item)),
					principal: access.principal,
					scope: PROFILE_SCOPE,
					policy: access.policyRevision,
				}),
			);
		}
		return { sources: [...new Set(sources)], complete };
	}
	const api = {
		readRunInTransaction: readHostInput,
		readMessageInTransaction: (db: Database, id: string) =>
			readHostInput(db, `message:${id}`),
		recordMessageInTransaction: (
			db: Database,
			id: string,
			input: ReferenceInput,
		) => writeHostInput(db, `message:${id}`, input),
		afterForgettingInTransaction: (db: Database) => deps.forgetSeq(db) > 0,
		messageReferences(refs: readonly string[], id: string) {
			return refs.filter((ref) => {
				const stamp = decode(ref);
				return stamp?.kind === "message" && stamp.id === id;
			});
		},
		recordRunInTransaction: writeHostInput,
		captureInTransaction: capture,
		confirmDeletionInTransaction(
			db: Database,
			forgetIds: readonly string[],
			providerRef: string,
			externalIds: readonly string[],
		) {
			for (const forgetId of forgetIds) {
				const h = header(db);
				const result = getForgetReceipt(db, {
					contractVersion: CONTRACT_VERSIONS.lifecycle,
					access: h.access,
					forgetId,
				});
				if (result.status !== "found")
					throw new Error("memory_forget_receipt_missing");
				for (const externalId of externalIds) {
					if (
						!result.receipt.externalDeletions.some(
							(d) =>
								d.providerRef === providerRef && d.externalId === externalId,
						)
					)
						continue;
					const confirmed = recordExternalDeletion(db, {
						contractVersion: CONTRACT_VERSIONS.lifecycle,
						access: h.access,
						clock: { atMs: deps.now() },
						forgetId,
						providerRef,
						externalId,
						state: "confirmed",
					});
					if (confirmed.status !== "recorded")
						throw new Error("memory_forget_unconfirmed");
				}
			}
		},
		/** Return the individual obsolete versions; unrelated inputs remain usable. */
		staleInTransaction(db: Database, refs: readonly string[]): string[] {
			if (!deps.healthy()) throw new Error("memory_unavailable");
			const stamps = refs.flatMap((ref) => {
				const stamp = decode(ref);
				return stamp ? [{ ref, stamp }] : [];
			});
			const now = capture(
				db,
				{
					messageIds: stamps
						.filter(({ stamp }) => stamp.kind === "message")
						.map(({ stamp }) => stamp.id),
					itemIds: stamps
						.filter(({ stamp }) => stamp.kind === "state")
						.map(({ stamp }) => stamp.id),
				},
				false,
			);
			const current = new Set(now.sources);
			return stamps
				.filter(({ ref }) => !current.has(ref))
				.map(({ ref }) => ref);
		},
		captureRecordInTransaction(
			db: Database,
			input: Pick<CaptureRecordInput, "origin" | "content" | "mediaType">,
		) {
			if (!deps.healthy()) throw new Error("memory_unavailable");
			const result = captureRecord(db, {
				...header(db),
				...input,
				captureState: "complete",
				clock: { atMs: deps.now() },
			});
			if (result.status !== "captured")
				throw new Error("memory_record_blocked");
			return result.ref;
		},
		readRecordInTransaction(
			db: Database,
			ref: Pick<ReadRecordInput, "recordId" | "revision">,
		) {
			if (!deps.healthy()) return null;
			const result = readRecord(db, { ...header(db), ...ref });
			return result.status === "available" && result.record.status === "active"
				? result
				: null;
		},
		/** A confirmed tombstone, distinct from missing, denied or temporarily unavailable data. */
		isRecordForgottenInTransaction(db: Database, recordId: string): boolean {
			if (!deps.healthy()) throw new Error("memory_unavailable");
			return readRecord(db, { ...header(db), recordId }).status === "forgotten";
		},
		/** Records' public identity contract: canonical JSON of this string array, then SHA-256. */
		isRecordOriginForgottenInTransaction(
			db: Database,
			origin: RecordOrigin,
		): boolean {
			const h = header(db);
			const id = `rec:${sha256Hex(
				JSON.stringify([
					h.access.principal,
					h.scopeKey,
					origin.namespace,
					origin.kind,
					origin.id,
				]),
			)}`;
			return api.isRecordForgottenInTransaction(db, id);
		},
		changesInTransaction(db: Database, afterSeq: number) {
			if (!deps.healthy()) throw new Error("memory_unavailable");
			const h = header(db);
			const result = listMemoryChanges(db, {
				contractVersion: 1,
				access: h.access,
				scopeKeys: [h.scopeKey],
				afterSeq,
				limit: 200,
			});
			if (result.status !== "ok") throw new Error("memory_blocked");
			return result;
		},
		registerInTransaction(
			db: Database,
			dependents: readonly ExternalDependent[],
		) {
			const result = registerExternalDependents(db, {
				...header(db),
				dependents,
				clock: { atMs: deps.now() },
			});
			if (result.status !== "registered")
				throw new Error("memory_dependency_blocked");
		},
		unregisterInTransaction(
			db: Database,
			dependents: readonly ExternalDependentKey[],
		) {
			const result = unregisterExternalDependents(db, {
				...header(db),
				dependents,
				clock: { atMs: deps.now() },
			});
			if (result.status !== "unregistered")
				throw new Error("memory_dependency_blocked");
		},
	};
	return {
		...api,
		isCurrentInTransaction(db: Database, input: ReferenceInput) {
			return (
				(input.complete || deps.forgetSeq(db) === 0) &&
				api.staleInTransaction(db, input.sources).length === 0
			);
		},
	};
}
