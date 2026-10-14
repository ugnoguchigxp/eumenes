import type { Database } from "bun:sqlite";
import type { z } from "zod";
import { createHmac } from "node:crypto";
import { canonicalJson } from "../../../infrastructure/digest";
import type { ArtifactDefinitionV1, FixedDocument } from "../../capabilities";
import type {
	ActionRequestStatus,
	ActionRequestView,
	AdapterRegistry,
	FieldError,
} from "../contracts";

/**
 * What the action ledger reads from capabilities. A narrow structural type so this domain does
 * not depend on the shape of the whole capabilities service (and tests use fakes).
 */
export interface CapabilityReads {
	/**
	 * Artifacts referenced by active toolchain revisions plus active standalone launcher
	 * artifacts (no toolchain). Availability is decided here from the artifact's sources.
	 */
	artifactsInTransaction(db: Database): ArtifactListEntry[];
	documentInTransaction(
		db: Database,
		revisionId: string,
	): FixedDocument<unknown> | null;
	/** Zod schema of a `builtin:`/`schema:` ref; null for `domain:` refs and unknown ones. */
	schemaInTransaction(db: Database, schemaRef: string): z.ZodType | null;
}

export const ACTION_POLICY = {
	/** A new request must be created at most this long ago. */
	windowMs: 24 * 3_600_000,
	/** Allowed clock skew into the future. */
	futureMs: 30_000,
	/** Rows (including tombstones) before ordinary actions are refused. */
	capacity: 4096,
	/** Extra rows only cancel operations may use. */
	cancelReserve: 64,
	/** Settled bodies are deleted after this, tombstones after the same time again. */
	bodyMs: 30 * 86_400_000,
	tombstoneMs: 30 * 86_400_000,
	conflictCapacity: 4096,
	unsettledLimit: 100,
} as const;

export type ActionRequestErrorStatus =
	| 400
	| 403
	| 404
	| 409
	| 410
	| 413
	| 422
	| 503;
/** A refusal that saved nothing (or only a conflict audit row). `status` is its HTTP status. */
export class ActionRequestError extends Error {
	constructor(
		readonly code: string,
		readonly status: ActionRequestErrorStatus,
		readonly fieldErrors?: FieldError[],
	) {
		super(code);
	}
}

export type LauncherMeta = { label: string; group?: string; order?: number };
export type ArtifactListEntry = {
	/** null for a standalone launcher artifact. */
	toolchainId: string | null;
	toolchainRevisionId: string | null;
	artifactRevisionId: string;
	title: string;
	/** The toolchain binding's adapter; absent for standalone artifacts (sources name theirs). */
	adapterRef?: string | null;
	launcher?: LauncherMeta | null;
};
export type ArtifactView = {
	artifact: ArtifactDefinitionV1;
	artifactRevisionId: string;
	digest: string;
	/** Opaque reference of the host scope; sent back with every action. */
	scopeRef: string;
};
export type SourceView = { revision: number; data: unknown };
export type SubmitResult = { request: ActionRequestView; replay: boolean };

export type Row = {
	event_id: string;
	scope: string;
	artifact_revision_id: string;
	source: string;
	source_revision: number;
	target_ref: string | null;
	action_id: string;
	adapter_ref: string;
	operation_name: string;
	issued_at: string;
	canonical_input_json: string | null;
	input_digest: string;
	status: ActionRequestStatus;
	error_code: string | null;
	receipt_owner: string | null;
	receipt_operation_id: string | null;
	receipt_digest: string | null;
	result_json: string | null;
	created_at: number;
	settled_at: number | null;
};

export const canonical = (value: unknown) =>
	canonicalJson(value, { omitUndefined: true, keyOrder: "codeUnit" });
export const isRecord = (v: unknown): v is Record<string, unknown> =>
	!!v && typeof v === "object" && !Array.isArray(v);
export const codePattern = /^[a-z_]+$/;
export const programmerErrors = [
	TypeError,
	RangeError,
	ReferenceError,
	SyntaxError,
];
export const isCancel = (operationName: string) =>
	operationName.endsWith(".cancel");
export const iso = (ms: number) => new Date(ms).toISOString();

export function fieldErrors(error: z.ZodError): FieldError[] {
	// The code, never the zod message: messages may quote the submitted value.
	return error.issues.slice(0, 20).map((issue) => ({
		field: issue.path.length ? issue.path.join(".") : "input",
		message: issue.code,
	}));
}

/** What every ledger operation needs from its host. */
export type LedgerContext = {
	capabilities: CapabilityReads;
	registry: AdapterRegistry;
	/** The host scope every request here belongs to (never taken from the client). */
	scope: string;
	scopeRef: string;
	now: () => number;
	epoch: () => number;
	/** Host key for HMAC digests of confidential input; undefined while unavailable. */
	secretKey: () => Uint8Array | undefined;
};

/** `hmac:<hex>` digest of an identity string that contains confidential input. */
export function hmacDigest(key: Uint8Array, identity: string) {
	return `hmac:${createHmac("sha256", key).update(identity).digest("hex")}`;
}
const isEmpty = (v: unknown) =>
	v === undefined ||
	v === null ||
	v === "" ||
	(Array.isArray(v) && v.length === 0) ||
	(isRecord(v) && Object.keys(v).length === 0);
/** True when the input carries a non-empty value under any confidential top-level key. */
export function hasSecret(input: unknown, confidential: readonly string[]) {
	return (
		isRecord(input) &&
		confidential.some((key) => key in input && !isEmpty(input[key]))
	);
}
/** The input with each confidential top-level key replaced by a marker (never the value). */
export function redactInput(input: unknown, confidential: readonly string[]) {
	if (!isRecord(input) || !confidential.length) return input;
	const out: Record<string, unknown> = { ...input };
	for (const key of confidential) if (key in out) out[key] = "[secret]";
	return out;
}
