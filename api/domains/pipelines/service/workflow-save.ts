import type { Database } from "bun:sqlite";
import { z } from "zod";
import { canonicalJson, sha256Hex } from "../../../infrastructure/digest";
import {
	checkWorkflowDefinition,
	type WorkflowCatalog,
} from "./workflow-definition";

const identifier = z.string().min(1).max(160);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const revision = z.number().int().positive();
const schemaSnapshot = z.strictObject({ revisionId: identifier, digest });
const draftSchema = z.strictObject({
	definition: z.json(),
	schemas: z.array(schemaSnapshot).max(32),
	artifact: z.strictObject({ id: identifier, revision, digest }).optional(),
	grant: z
		.strictObject({
			conversationId: identifier,
			authorityDigest: digest.optional(),
		})
		.optional(),
	componentsDigest: digest.optional(),
	authoringDigest: digest.optional(),
});
const saveSchema = z.strictObject({
	scope: identifier,
	workflowId: identifier,
	operationId: z.uuid(),
	expectedRevision: z.number().int().nonnegative(),
	confirmedDigest: digest,
	draft: draftSchema,
});

export const workflowDraftDigest = (draft: unknown) =>
	sha256Hex(
		canonicalJson(draftSchema.parse(draft), {
			omitUndefined: true,
			keyOrder: "codeUnit",
		}),
	);

export const workflowComponentsDigest = (pins: unknown) =>
	sha256Hex(canonicalJson(pins, { omitUndefined: true, keyOrder: "codeUnit" }));

type SavedValue = ReturnType<typeof checkWorkflowDefinition> &
	Pick<
		z.infer<typeof draftSchema>,
		"schemas" | "artifact" | "grant" | "authoringDigest"
	>;
type SavedWorkflow = {
	workflowId: string;
	revision: number;
	digest: string;
	value: SavedValue;
};
type SaveCatalog = WorkflowCatalog & {
	/** Return a digest only for a generated schema owned by this workflow. */
	schemaDigest(ref: string): string | null;
	artifactDigest(id: string, revision: number): string | null;
};

export function workflowRevisionInTransaction(
	db: Database,
	scope: string,
	workflowId: string,
	atRevision?: number,
): SavedWorkflow | null {
	const row = db
		.query<
			{ revision: number; digest: string; value_json: string },
			[string, string, number | null]
		>(
			`SELECT revision,digest,value_json FROM workflow_definition_revisions
			 WHERE scope=? AND workflow_id=? AND revision=COALESCE(?,revision)
			 ORDER BY revision DESC LIMIT 1`,
		)
		.get(scope, workflowId, atRevision ?? null);
	return row
		? {
				workflowId,
				revision: row.revision,
				digest: row.digest,
				value: JSON.parse(row.value_json) as SavedValue,
			}
		: null;
}

function saveReceipt(db: Database, scope: string, operationId: string) {
	return db
		.query<
			{ input_digest: string; workflow_id: string; revision: number },
			[string, string]
		>(
			"SELECT input_digest,workflow_id,revision FROM workflow_save_receipts WHERE scope=? AND operation_id=?",
		)
		.get(scope, operationId);
}

export function workflowSaveReceiptInTransaction(
	db: Database,
	scope: string,
	operationId: string,
) {
	const receipt = saveReceipt(db, scope, operationId);
	return receipt
		? workflowRevisionInTransaction(
				db,
				scope,
				receipt.workflow_id,
				receipt.revision,
			)
		: null;
}

/** The caller verifies confirmation and linked assets inside its writer transaction. */
export function saveWorkflowInTransaction(
	db: Database,
	raw: unknown,
	sourceRequest: string,
	catalog: SaveCatalog,
): SavedWorkflow {
	const input = saveSchema.parse(raw);
	const { scope, workflowId, operationId, draft } = input;
	const confirmedDigest = workflowDraftDigest(draft);
	if (confirmedDigest !== input.confirmedDigest)
		throw new Error("workflow_confirmation_changed");
	const inputDigest = sha256Hex(
		JSON.stringify([
			workflowId,
			input.expectedRevision,
			confirmedDigest,
			sourceRequest,
		]),
	);
	const previous = saveReceipt(db, scope, operationId);
	if (previous) {
		if (previous.input_digest !== inputDigest)
			throw new Error("request_conflict");
		const saved = workflowRevisionInTransaction(
			db,
			scope,
			previous.workflow_id,
			previous.revision,
		);
		if (!saved) throw new Error("workflow_revision_missing");
		return saved;
	}
	const current = workflowRevisionInTransaction(db, scope, workflowId);
	if ((current?.revision ?? 0) !== input.expectedRevision)
		throw new Error("workflow_revision_conflict");
	const checked = checkWorkflowDefinition(
		draft.definition,
		sourceRequest,
		catalog,
	);
	if (
		draft.componentsDigest &&
		workflowComponentsDigest(checked.pins) !== draft.componentsDigest
	)
		throw new Error("workflow_components_changed");
	if (checked.definition.publish.kind === "dataset" && !draft.artifact)
		throw new Error("workflow_artifact_required");
	const schemaSnapshots = new Map(
		draft.schemas.map((item) => [item.revisionId, item.digest]),
	);
	const refs = [
		checked.definition.input.schemaRef,
		...checked.pins.map((pin) => pin.outputSchemaRef),
		...(checked.definition.checkpoint
			? [checked.definition.checkpoint.schemaRef]
			: []),
	];
	if (
		schemaSnapshots.size !== draft.schemas.length ||
		draft.schemas.some(
			(item) => catalog.schemaDigest(item.revisionId) !== item.digest,
		) ||
		refs.some((ref) => {
			const ownedDigest = catalog.schemaDigest(ref);
			return ownedDigest !== null && schemaSnapshots.get(ref) !== ownedDigest;
		})
	)
		throw new Error("workflow_schema_snapshot_changed");
	if (
		draft.artifact &&
		catalog.artifactDigest(draft.artifact.id, draft.artifact.revision) !==
			draft.artifact.digest
	)
		throw new Error("workflow_artifact_snapshot_changed");
	const next = input.expectedRevision + 1;
	const value = {
		...checked,
		schemas: draft.schemas,
		...(draft.artifact ? { artifact: draft.artifact } : {}),
		...(draft.grant ? { grant: draft.grant } : {}),
		...(draft.authoringDigest
			? { authoringDigest: draft.authoringDigest }
			: {}),
	};
	db.query(
		"INSERT INTO workflow_definition_revisions(scope,workflow_id,revision,digest,value_json) VALUES(?,?,?,?,?)",
	).run(scope, workflowId, next, confirmedDigest, JSON.stringify(value));
	db.query(
		"INSERT INTO workflow_save_receipts(scope,operation_id,input_digest,workflow_id,revision) VALUES(?,?,?,?,?)",
	).run(scope, operationId, inputDigest, workflowId, next);
	return { workflowId, revision: next, digest: confirmedDigest, value };
}
