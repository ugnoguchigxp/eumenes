import type { Database } from "bun:sqlite";
import { z } from "zod";
import { bundleSchemaV1, bytes, hash } from "../contracts";
import {
	getDocument,
	insertDocument,
	type StoredDocument,
} from "../repository";
import { compileJsonSchemaSubset } from "./json-schema-subset";

// Ordinary bundle IDs are slugs. This owner marker is issued only by the host.
const ownerPrefix = "workflow-schema:";
const ownerSchema = z.strictObject({
	scope: z.string().min(1).max(160),
	workflowId: z.string().min(1).max(160),
});
const registrationSchema = ownerSchema.extend({
	name: z.string().regex(/^[a-z][a-z0-9-]{0,29}$/),
	revision: z.number().int().positive(),
	schema: z.record(z.string(), z.unknown()),
});
type Owner = z.infer<typeof ownerSchema>;
const ownerDigest = ({ scope, workflowId }: Owner) => hash([scope, workflowId]);

export function isWorkflowSchema(stored: StoredDocument | null): boolean {
	return stored?.kind === "schema" && stored.bundleId.startsWith(ownerPrefix);
}

export function prepareWorkflowSchema(raw: unknown) {
	const input = registrationSchema.parse(raw);
	const owner = ownerDigest(input);
	const document = bundleSchemaV1.parse({
		kind: "schema",
		id: `workflow.${owner.slice(0, 40)}.${input.name}`,
		revision: input.revision,
		schema: input.schema,
	});
	if (bytes(document) > 65_536) throw new Error("workflow_schema_too_large");
	const validate = compileJsonSchemaSubset(document.schema);
	const revisionId = `schema:${document.id}@${document.revision}`;
	const digest = hash(document);
	return {
		revisionId,
		digest,
		document,
		bundleId: ownerPrefix + owner,
		validate,
	};
}

/** Register only a scoped, immutable schema in the caller's save transaction. */
export function registerWorkflowSchemaInTransaction(
	db: Database,
	raw: unknown,
	nowMs: number,
) {
	const { revisionId, digest, document, bundleId } = prepareWorkflowSchema(raw);
	const existing = getDocument(db, revisionId);
	if (existing) {
		if (existing.bundleId !== bundleId || existing.digest !== digest)
			throw new Error("capability_revision_conflict");
	} else {
		insertDocument(db, {
			revisionId,
			kind: "schema",
			itemId: document.id,
			revision: document.revision,
			digest,
			document,
			bundleId,
			createdAtMs: nowMs,
		});
	}
	return { revisionId, digest, document };
}

export function workflowSchemaInTransaction(
	db: Database,
	revisionId: string,
	owner: Owner,
) {
	const stored = getDocument(db, revisionId);
	if (
		stored?.kind !== "schema" ||
		stored.bundleId !== ownerPrefix + ownerDigest(owner)
	)
		return null;
	const { schema } = bundleSchemaV1.parse(stored.document);
	return { digest: stored.digest, validate: compileJsonSchemaSubset(schema) };
}
