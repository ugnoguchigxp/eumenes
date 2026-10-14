import { z } from "zod";
import type {
	ArtifactDefinitionV1,
	BundleHost,
	DocumentDescription,
	DocumentFieldV1,
	DocumentPathInfo,
} from "../contracts";
import { schemaInTransaction } from "./documents";
import type { Check } from "./bundles";

type Artifact = ArtifactDefinitionV1;
type HostAdapter = NonNullable<ReturnType<BundleHost["adapters"]["get"]>>;
type Claim = { artifactId: string; revision: number };

/** The adapter (ref and registration) that owns a document, preferring the artifact's own. */
export function documentOwner(
	c: Check,
	document: string,
	prefer: ReadonlySet<string> = new Set(),
): [string, HostAdapter] | undefined {
	const owners = [...c.host.adapters].filter(([, a]) =>
		a.documents?.has(document),
	);
	return owners.find(([ref]) => prefer.has(ref)) ?? owners[0];
}

/** Property names of an object schema reference, or null when it cannot be read. */
export function schemaProperties(c: Check, ref: string): string[] | null {
	const local = c.bundle.schemas.find(
		(x) => `schema:${x.id}@${x.revision}` === ref,
	);
	const json = local
		? local.schema
		: (() => {
				const zod = schemaInTransaction(c.db, ref);
				return zod ? (z.toJSONSchema(zod) as Record<string, unknown>) : null;
			})();
	const properties = json?.properties;
	return properties && typeof properties === "object"
		? Object.keys(properties)
		: null;
}

/** Record who registered a field id and a (document, path); false when another artifact has. */
export function claimField(
	claims: Map<string, Claim>,
	field: DocumentFieldV1,
	artifactId: string,
	revision: number,
) {
	let free = true;
	for (const key of [
		`id\n${field.fieldId}`,
		`path\n${field.document}\n${field.path}`,
	]) {
		const first = claims.get(key);
		// Other revisions of the same artifact id replace each other, they do not clash.
		if (
			first &&
			!(first.artifactId === artifactId && first.revision !== revision)
		)
			free = false;
		else if (!first) claims.set(key, { artifactId, revision });
	}
	return free;
}

const controlKinds: Record<
	DocumentFieldV1["control"],
	DocumentPathInfo["kind"][]
> = {
	toggle: ["boolean"],
	number: ["number", "integer"],
	range: ["number", "integer"],
	select: ["enum", "string"],
	multiple: ["array"],
	text: ["string"],
};

/** Whether a display-only default fits the schema kind and the field's own limits. */
function validDefault(field: DocumentFieldV1, info: DocumentPathInfo) {
	const value = field.defaultValue!;
	if (field.confidential) return false;
	if (field.options?.length && !field.options.some((o) => o.value === value))
		return false;
	switch (info.kind) {
		case "boolean":
			return value === "true" || value === "false";
		case "number":
		case "integer": {
			const n = Number(value);
			const lo = field.min ?? info.min;
			const hi = field.max ?? info.max;
			return (
				value.trim() !== "" &&
				Number.isFinite(n) &&
				(info.kind === "number" || Number.isInteger(n)) &&
				(lo === undefined || n >= lo) &&
				(hi === undefined || n <= hi)
			);
		}
		case "enum":
			return !info.values || info.values.includes(value);
		case "string": {
			const max = field.maxLength ?? info.maxLength;
			return max === undefined || value.length <= max;
		}
		default:
			return false;
	}
}

/** Everything a field says on top of its path must agree with the document schema's kind. */
function checkAgainstSchema(
	c: Check,
	field: DocumentFieldV1,
	info: DocumentPathInfo,
	at: string,
) {
	const { issue } = c;
	if (!controlKinds[field.control].includes(info.kind))
		issue("schema_mismatch", `${at}/control`, field.control);
	const fixed = field.options?.map((o) => o.value);
	if (
		(field.control === "select" || field.control === "multiple") &&
		!fixed?.length &&
		!field.optionsSource
	)
		issue("invalid_format", `${at}/options`);
	if (
		fixed &&
		info.values &&
		(info.kind === "enum" || info.kind === "array") &&
		fixed.some((v) => !info.values!.includes(v))
	)
		issue("schema_mismatch", `${at}/options`);
	const numeric = info.kind === "number" || info.kind === "integer";
	for (const key of ["min", "max", "step"] as const)
		if (field[key] !== undefined && !numeric)
			issue("invalid_format", `${at}/${key}`);
	if (numeric) {
		const { min, max } = field;
		if (
			(min !== undefined &&
				((info.min !== undefined && min < info.min) ||
					(info.max !== undefined && min > info.max))) ||
			(min !== undefined && max !== undefined && min > max)
		)
			issue("schema_mismatch", `${at}/min`);
		if (
			max !== undefined &&
			((info.max !== undefined && max > info.max) ||
				(info.min !== undefined && max < info.min))
		)
			issue("schema_mismatch", `${at}/max`);
	}
	if (field.maxLength !== undefined) {
		if (info.kind !== "string") issue("invalid_format", `${at}/maxLength`);
		else if (info.maxLength !== undefined && field.maxLength > info.maxLength)
			issue("schema_mismatch", `${at}/maxLength`);
	}
	if (
		(field.unset === "delete-key" && !info.optional) ||
		(field.unset === "null" && !info.nullable) ||
		(field.unset === "empty-string" && info.kind !== "string")
	)
		issue("schema_mismatch", `${at}/unset`, field.unset);
	if (field.defaultValue !== undefined && !validDefault(field, info))
		issue("invalid_format", `${at}/defaultValue`, field.defaultValue);
}

/** `[id=$target]` fields list their targets with the query the adapter names for that path. */
function checkTarget(
	c: Check,
	a: Artifact,
	field: DocumentFieldV1,
	description: DocumentDescription,
	at: string,
) {
	const selects = field.path.includes("[id=$target]");
	if (selects !== (field.target !== undefined)) {
		c.issue("invalid_format", `${at}/target`, field.target);
		return;
	}
	if (field.target === undefined) return;
	const source = a.sourceBindings.find((s) => s.source === field.target);
	if (!source) {
		c.issue("unknown_reference", `${at}/target`, field.target);
		return;
	}
	const expected = description.targetQuery?.(field.path);
	if (!expected) c.issue("invalid_format", `${at}/target`, field.path);
	else if (source.query !== expected)
		c.issue("schema_mismatch", `${at}/target`, expected);
}

/**
 * Registered document fields: the document belongs to an adapter whose schema describes the
 * path, control and limits agree with that description, array targets use the adapter's target
 * query, options and conditions are registered by the adapter, and a field id and a
 * (document, path) are each registered once in the whole published catalog.
 */
export function checkFields(c: Check, a: Artifact, path: string) {
	const own = new Set(a.sourceBindings.map((s) => s.adapterRef));
	a.fields?.forEach((field, i) => {
		const at = `${path}/fields/${i}`;
		if (!claimField(c.fieldClaims, field, a.id, a.revision))
			c.issue("invalid_format", `${at}/fieldId`, field.fieldId);
		const owner = documentOwner(c, field.document, own);
		if (!owner) {
			c.issue("unknown_reference", `${at}/document`, field.document);
			return;
		}
		const [, adapter] = owner;
		const description = adapter.documents!.get(field.document)!;
		const info = description.describePath(field.path);
		if (info) checkAgainstSchema(c, field, info, at);
		else c.issue("invalid_format", `${at}/path`, field.path);
		checkTarget(c, a, field, description, at);
		if (field.optionsSource && field.options)
			c.issue("invalid_format", `${at}/options`);
		if (field.optionsSource && !adapter.queries.has(field.optionsSource))
			c.issue("unregistered_query", `${at}/optionsSource`, field.optionsSource);
		if (field.visibleWhen && !adapter.conditions?.has(field.visibleWhen))
			c.issue("unknown_reference", `${at}/visibleWhen`, field.visibleWhen);
	});
}

/** Confidential fields travel only in declared top-level input properties. */
function checkConfidential(
	c: Check,
	action: Artifact["actionBindings"][number],
	at: string,
) {
	const declared = action.confidentialFields ?? [];
	const properties = schemaProperties(c, action.inputSchemaRef);
	declared.forEach((name, k) => {
		if (!properties?.includes(name))
			c.issue("schema_mismatch", `${at}/confidentialFields/${k}`, name);
	});
	if (
		action.effect === "write" &&
		action.draftDocument &&
		c.confidentialDocs.has(action.draftDocument) &&
		!declared.length
	)
		c.issue("permission", `${at}/confidentialFields`, action.draftDocument);
}

/** Draft, navigation and write actions: their document, destination and operation. */
export function checkActionTargets(
	c: Check,
	action: Artifact["actionBindings"][number],
	at: string,
	sourceAdapter: HostAdapter | undefined,
) {
	if (action.draftDocument) {
		if (!documentOwner(c, action.draftDocument))
			c.issue("unknown_reference", `${at}/draftDocument`, action.draftDocument);
		// A write applying a draft runs where the document lives: its source's adapter owns it.
		else if (
			action.effect === "write" &&
			sourceAdapter &&
			!sourceAdapter.documents?.has(action.draftDocument)
		)
			c.issue("schema_mismatch", `${at}/draftDocument`, action.draftDocument);
	}
	const nav = action.navigateTo;
	if (nav) {
		const targets =
			"artifactId" in nav
				? [[`${at}/navigateTo`, nav.artifactId] as const]
				: Object.entries(nav.artifacts).map(
						([value, id]) =>
							[`${at}/navigateTo/artifacts/${value}`, id] as const,
					);
		for (const [path, id] of targets)
			if (!c.hasArtifactId(id)) c.issue("unknown_reference", path, id);
	}
	checkConfidential(c, action, at);
	if (
		action.operationId &&
		sourceAdapter &&
		!sourceAdapter.operations.has(action.operationId)
	)
		c.issue("unregistered_operation", `${at}/operationId`, action.operationId);
}
