import type { Database } from "bun:sqlite";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
	sliceUtf8Range,
	type AccessContext,
	type SourceRef,
} from "eumenes-memory";
import {
	CONVERSATION_SOURCE_KIND,
	CONVERSATION_SOURCE_NAMESPACE,
	CONVERSATION_SOURCE_REPRESENTATION,
	type ConversationService,
	type OutboxEvent,
} from "../../conversation";
import type {
	ListChangesRequest,
	SourceAdapter,
	SourceChange,
	SourceChangePage,
	SourceContent,
	SourceCurrent,
	SourceKey,
} from "../contracts";

export class SourceAccessError extends Error {
	constructor(readonly code: "invalid_access" | "purpose_not_allowed") {
		super(code);
	}
}
export class SourceCursorError extends Error {
	constructor() {
		super("invalid_source_cursor");
	}
}

const MAX_PAGE = 500;
const SCAN_BATCH = 200;
const CURSOR = /^c1\.([0-9a-f]{14})\.([0-9a-f]{12})$/;
const MIN_CURSOR_SECRET_CHARS = 8;
/**
 * Opaque, versioned, tamper-evident cursor. The position is the conversation
 * outbox sequence (never exposed raw): it is masked with a key-derived value and
 * carries a short MAC, so a caller can neither read nor forge positions. The
 * cursor may point past events the caller cannot see (scanned out-of-scope tail)
 * and never moves backwards. Secrecy only holds as far as the secret does, so
 * the host MUST pass a stable `cursorSecret`: there is deliberately no default,
 * because a public constant would let anyone decode the raw global sequence.
 */
function createCursorCodec(secret: string) {
	if (typeof secret !== "string" || secret.length < MIN_CURSOR_SECRET_CHARS)
		throw new Error("world_cursor_secret_required");
	const hmac = (data: string) =>
		createHmac("sha256", secret).update(data).digest();
	const mask = BigInt(`0x${hmac("mask").subarray(0, 7).toString("hex")}`);
	const mac = (seq: number) => hmac(`c1:${seq}`).subarray(0, 6).toString("hex");
	return {
		encode(seq: number): string {
			const masked = (BigInt(seq) ^ mask).toString(16).padStart(14, "0");
			return `c1.${masked}.${mac(seq)}`;
		},
		decode(cursor: string | null): number {
			if (cursor === null) return 0;
			const match = CURSOR.exec(cursor);
			if (!match) throw new SourceCursorError();
			const seq = Number(BigInt(`0x${match[1]}`) ^ mask);
			if (!Number.isSafeInteger(seq) || seq < 0) throw new SourceCursorError();
			const expected = Buffer.from(mac(seq), "hex");
			const given = Buffer.from(match[2] as string, "hex");
			if (!timingSafeEqual(expected, given)) throw new SourceCursorError();
			return seq;
		},
	};
}

/** Order-independent application order: retractions first, superseded events dropped. */
export function deletionsFirst(
	changes: readonly SourceChange[],
): SourceChange[] {
	const retracted = new Set<string>();
	for (const change of changes)
		if (change.kind === "retracted") retracted.add(change.source.id);
	const deletions: SourceChange[] = [];
	const rest: SourceChange[] = [];
	const seen = new Set<string>();
	for (let i = changes.length - 1; i >= 0; i--) {
		const change = changes[i] as SourceChange;
		if (change.kind === "retracted") {
			if (!seen.has(change.source.id)) {
				seen.add(change.source.id);
				deletions.unshift(change);
			}
		} else if (!retracted.has(change.source.id)) rest.unshift(change);
	}
	return [...deletions, ...rest];
}

export type ConversationSourceAdapterOptions = {
	/**
	 * Purposes allowed to read conversation sources. Deny by default: the host
	 * names them, the adapter invents none.
	 */
	allowedPurposes: readonly string[];
	/**
	 * REQUIRED stable secret (at least 8 characters, host-owned, never logged)
	 * that masks and authenticates the opaque change cursor. Changing it
	 * invalidates stored cursors (callers get invalid_source_cursor).
	 */
	cursorSecret: string;
};

const key = (id: string): SourceKey => ({
	namespace: CONVERSATION_SOURCE_NAMESPACE,
	kind: CONVERSATION_SOURCE_KIND,
	id,
	representation: CONVERSATION_SOURCE_REPRESENTATION,
});
const isConversationSource = (ref: {
	namespace: string;
	kind: string;
	representation?: string;
}) =>
	ref.namespace === CONVERSATION_SOURCE_NAMESPACE &&
	ref.kind === CONVERSATION_SOURCE_KIND &&
	(ref.representation ?? CONVERSATION_SOURCE_REPRESENTATION) ===
		CONVERSATION_SOURCE_REPRESENTATION;

/**
 * SourceAdapter for confirmed conversation messages. It reads only through the
 * conversation domain's public service, never its tables.
 */
export function createConversationSourceAdapter(
	conversation: ConversationService,
	options: ConversationSourceAdapterOptions,
): SourceAdapter {
	const purposes = new Set(options.allowedPurposes);
	const cursors = createCursorCodec(options.cursorSecret);
	function checkAccess(access: AccessContext) {
		if (
			typeof access?.principal !== "string" ||
			access.principal === "" ||
			!Array.isArray(access.scopeKeys) ||
			typeof access.purpose !== "string" ||
			access.purpose === ""
		)
			throw new SourceAccessError("invalid_access");
		if (!purposes.has(access.purpose))
			throw new SourceAccessError("purpose_not_allowed");
	}
	const inScope = (
		access: AccessContext,
		source: { principal: string; scopeKey: string },
	) =>
		access.principal === source.principal &&
		access.scopeKeys.includes(source.scopeKey);
	const NOT_FOUND = (id: string) =>
		({ status: "missing", source: key(id), reason: "not_found" }) as const;

	function resolveCurrent(
		db: Database,
		access: AccessContext,
		source: SourceKey,
	): SourceCurrent {
		checkAccess(access);
		if (!isConversationSource(source)) return NOT_FOUND(source.id);
		const state = conversation.sourceInTransaction(db, source.id);
		if (state.state === "missing" || !inScope(access, state))
			return NOT_FOUND(source.id);
		if (state.state === "retracted")
			return { status: "missing", source: key(source.id), reason: "retracted" };
		return {
			status: "available",
			source: key(source.id),
			revision: state.revision,
			digest: state.digest,
			principal: state.principal,
			scopeKey: state.scopeKey,
			speaker: state.message.role,
			confirmed: true,
			ordinal: state.ordinal,
		};
	}

	function readAuthorizedContent(
		db: Database,
		access: AccessContext,
		ref: SourceRef,
	): SourceContent {
		checkAccess(access);
		// Scope first: nothing below may differ between "absent" and "not yours".
		if (!isConversationSource(ref)) return NOT_FOUND(ref.id);
		const state = conversation.sourceInTransaction(db, ref.id);
		if (state.state === "missing" || !inScope(access, state))
			return NOT_FOUND(ref.id);
		if (state.state === "retracted")
			return { status: "missing", source: key(ref.id), reason: "retracted" };
		if (ref.revision !== state.revision || ref.digest !== state.digest)
			return {
				status: "changed",
				source: key(ref.id),
				currentRevision: state.revision,
			};
		const text = state.message.text;
		if (!ref.range)
			return {
				status: "ok",
				source: key(ref.id),
				revision: state.revision,
				digest: state.digest,
				text,
			};
		const { startByte, endByte } = ref.range;
		if (
			!Number.isSafeInteger(startByte) ||
			!Number.isSafeInteger(endByte) ||
			startByte < 0 ||
			endByte <= startByte
		)
			return {
				status: "invalid_range",
				source: key(ref.id),
				reasonCode: "SOURCE_RANGE_OUT_OF_BOUNDS",
			};
		// UTF-8 byte offsets on code point boundaries (memory's ByteRange semantics).
		const slice = sliceUtf8Range(text, ref.range);
		if (slice.status === "invalid_range")
			return {
				status: "invalid_range",
				source: key(ref.id),
				reasonCode: slice.reasonCode,
			};
		return {
			status: "ok",
			source: key(ref.id),
			revision: state.revision,
			digest: state.digest,
			text: slice.text,
			quoteDigest: slice.digest,
		};
	}

	const toChange = (event: OutboxEvent): SourceChange => ({
		cursor: cursors.encode(event.seq),
		kind: event.kind,
		source: {
			namespace: event.namespace,
			kind: event.sourceKind,
			id: event.sourceId,
			representation: event.representation,
		},
		revision: event.revision,
		digest: event.digest,
		principal: event.principal,
		scopeKey: event.scopeKey,
		speaker: event.speaker,
		occurredAt: event.occurredAt,
	});

	function listChanges(
		db: Database,
		access: AccessContext,
		request: ListChangesRequest,
	): SourceChangePage {
		checkAccess(access);
		if (
			!Number.isInteger(request.limit) ||
			request.limit < 1 ||
			request.limit > MAX_PAGE
		)
			throw new RangeError("invalid_limit");
		const start = cursors.decode(request.cursor);
		const changes: SourceChange[] = [];
		let after = start;
		let hasMore = false;
		// Out-of-scope events are skipped silently. When the page is exhausted the
		// cursor moves past the scanned tail (so a caller with nothing to see does
		// not rescan the outbox every poll); the cursor is opaque, so its movement
		// does not reveal how many events other principals have.
		scan: for (;;) {
			const batch = conversation.changesInTransaction(db, after, SCAN_BATCH);
			if (batch.length === 0) break;
			for (const event of batch) {
				if (!inScope(access, event)) {
					after = event.seq;
					continue;
				}
				if (changes.length === request.limit) {
					// Resume just before the first event that did not fit.
					after = event.seq - 1;
					hasMore = true;
					break scan;
				}
				after = event.seq;
				changes.push(toChange(event));
			}
		}
		return {
			changes,
			nextCursor: cursors.encode(after),
			hasMore,
		};
	}

	return {
		namespace: CONVERSATION_SOURCE_NAMESPACE,
		resolveCurrent,
		readAuthorizedContent,
		listChanges,
	};
}
