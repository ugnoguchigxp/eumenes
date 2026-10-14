import type { Database } from "bun:sqlite";
import type { AccessContext } from "eumenes-memory";
import type { HostSourceState } from "eumenes-memory/sqlite";
import { sha256Hex } from "../../../infrastructure/digest";
import type { ConversationService } from "../../conversation";
import type { ContinuityService } from "../../continuity";
import {
	PRINCIPAL,
	PROFILE_SCOPE,
	stateKinds,
	type CurationItem,
	type CurationRejection,
	type CurationResult,
} from "../contracts";
import type { ContextWindowStore } from "./context-window";

/** Active State items kept in the shared profile. Keeps the fixed view inside its byte budget. */
export const MAX_ACTIVE_ITEMS = 100;
export const MAX_TEXT_CHARS = 500;
/** The library keeps at most this many bytes of a quote. */
export const MAX_QUOTE_BYTES = 1024;
export const MAX_EVIDENCE = 8;
export const SOURCE_REPRESENTATION = "text";

type Scoped = {
	contractVersion: 1;
	access: AccessContext;
	scopeKey: string;
};
export type CurationDeps = {
	conversation: ConversationService;
	continuity: ContinuityService;
	windows: ContextWindowStore;
	clock: () => string;
	id: () => string;
	atMs: () => number;
	ready: () => boolean;
	scoped: (db: Database, purpose: string) => Scoped;
};
export type Evidence = {
	source: {
		namespace: string;
		kind: string;
		id: string;
		representation: string;
		revision: string;
		digest: string;
		range: { startByte: number; endByte: number };
	};
	quote: string;
};

export const isStateKind = (
	kind: string,
): kind is (typeof stateKinds)[number] =>
	(stateKinds as readonly string[]).includes(kind);
export const byteLength = (text: string) => Buffer.byteLength(text, "utf8");
export const applied = (
	op: CurationItem["op"],
	extra: Partial<Extract<CurationResult, { status: "applied" }>> = {},
): CurationResult => ({
	status: "applied",
	op,
	id: null,
	revision: null,
	changed: true,
	quoteMatched: null,
	reconfirmed: false,
	stoppedIds: [],
	...extra,
});
export const rejected = (
	op: CurationItem["op"],
	reason: CurationRejection,
): CurationResult => ({ status: "rejected", op, reason });

/** The message as the library's evidence check sees it (its digest is that of the current text). */
export function hostMessageSource(
	found: NonNullable<ReturnType<ConversationService["messageInTransaction"]>>,
): HostSourceState {
	const digest = sha256Hex(found.message.text);
	return {
		namespace: "conversation",
		kind: "message",
		id: found.message.id,
		representation: SOURCE_REPRESENTATION,
		revision: `sha256:${digest}`,
		digest,
		principal: PRINCIPAL,
		scopeKey: PROFILE_SCOPE,
		status: "available",
		content: found.message.text,
		ordinal: found.ordinal,
	};
}
export function refOf(
	source: HostSourceState,
	range: { startByte: number; endByte: number },
): Evidence["source"] {
	return {
		namespace: source.namespace,
		kind: source.kind,
		id: source.id,
		representation: SOURCE_REPRESENTATION,
		revision: source.revision,
		digest: source.digest,
		range,
	};
}
