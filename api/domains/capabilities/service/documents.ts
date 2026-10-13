import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
	artifactDefinitionV1,
	bundleSchemaV1,
	commandBindingV1,
	validators,
	type ArtifactDefinitionV1,
	type CommandBindingV1,
	type FixedDocument,
} from "../contracts";
import { getDocument, type StoredDocument } from "../repository";
import { compileJsonSchemaSubset } from "./json-schema-subset";

function typed<T>(
	stored: StoredDocument | null,
	kind: StoredDocument["kind"],
	schema: z.ZodType<T>,
): FixedDocument<T> | null {
	if (stored?.kind !== kind) return null;
	const parsed = schema.safeParse(stored.document);
	return parsed.success
		? {
				revisionId: stored.revisionId,
				digest: stored.digest,
				document: parsed.data,
			}
		: null;
}
/** A stored command binding (HTTP bindings are not command bindings). */
export function commandBindingInTransaction(
	db: Database,
	revisionId: string,
): FixedDocument<CommandBindingV1> | null {
	return typed(getDocument(db, revisionId), "binding", commandBindingV1);
}
export function artifactInTransaction(
	db: Database,
	revisionId: string,
): FixedDocument<ArtifactDefinitionV1> | null {
	return typed(getDocument(db, revisionId), "artifact", artifactDefinitionV1);
}
/**
 * The validator a schema reference names: `builtin:<SchemaKey>` is a validator of this
 * repository, `schema:<id>@<n>` a stored bundle schema compiled from the finite subset.
 * `domain:` references belong to the host, which returns null here, and so does anything unknown.
 */
export function schemaInTransaction(
	db: Database,
	ref: string,
): z.ZodType | null {
	if (ref.startsWith("builtin:")) {
		const key = ref.slice("builtin:".length);
		return Object.hasOwn(validators, key)
			? (validators[key as keyof typeof validators] as z.ZodType)
			: null;
	}
	if (!ref.startsWith("schema:")) return null;
	const stored = typed(getDocument(db, ref), "schema", bundleSchemaV1);
	if (!stored) return null;
	try {
		return compileJsonSchemaSubset(stored.document.schema);
	} catch {
		return null;
	}
}
