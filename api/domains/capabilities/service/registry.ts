import type { Database } from "bun:sqlite";
import { getLogger } from "../../../infrastructure/logger";
import {
	bytes,
	hash,
	artifactRevisionIdPattern,
	bindingRevisionIdPattern,
	toolchainFunctionPattern,
	toolchainImpacts,
	validators,
	isReadToolName,
	type Definition,
	type FixedDefinition,
} from "../contracts";
import { zSchema } from "./schema";
import { artifactInTransaction, bindingInTransaction } from "./documents";
import {
	resourceDefinitionKinds,
	validateResourceDefinition,
} from "./resource-kinds";
export function registerRevision(
	db: Database,
	d: Definition,
	origin: "builtin" | "user",
	closure: (db: Database, revisionId: string) => FixedDefinition[],
	now: () => number,
) {
	if (d.schemaKey) {
		const actual = hash(zSchema(d.schemaKey));
		if (d.schemaHash && actual !== d.schemaHash)
			throw new Error("invalid_capability_schema");
		d = { ...d, schemaHash: actual };
	}
	if (
		!/^[a-z][a-z0-9._-]{0,100}$/.test(d.id) ||
		!Number.isInteger(d.revision) ||
		d.revision < 1 ||
		bytes(d) > 32768
	)
		throw new Error("invalid_capability");
	if (d.schemaKey && !validators[d.schemaKey])
		throw new Error("invalid_capability_schema");
	const key = `${d.kind}:${d.id}`,
		rev = `${key}@${d.revision}`,
		digest = hash(d);
	const old = db
		.query("SELECT definition_hash FROM capability_revisions WHERE id=?")
		.get(rev) as { definition_hash: string } | null;
	if (old) {
		if (old.definition_hash !== digest) {
			if (origin === "builtin")
				getLogger("capabilities").warn("capability.revision_conflict", {
					subjectId: rev,
					reason: "capability_revision_conflict",
				});
			throw new Error("capability_revision_conflict");
		}
		return;
	}
	const dependencies = d.dependencies.flatMap((id) => closure(db, id));
	if (d.kind === "package") {
		const has = (id: string | undefined, kind: Definition["kind"]) =>
			!!id &&
			dependencies.some(
				(item) =>
					item.revisionId === id &&
					item.kind === kind &&
					(kind === "tool" ? !!item.schemaKey : !!item.body?.trim()),
			);
		if (
			!has(d.profileRevisionId, "profile") ||
			!d.requiredSkillRevisionIds?.length ||
			d.requiredSkillRevisionIds.some((id) => !has(id, "skill")) ||
			// No tools only for an agent that edits a work document with the host's tools (checked per toolchain).
			!d.toolRevisionIds ||
			d.toolRevisionIds.some((id) => !has(id, "tool"))
		)
			throw new Error("invalid_capability_bundle");
	}
	if (resourceDefinitionKinds.includes(d.kind)) validateResourceDefinition(d);
	else if (d.resourceKindData !== undefined)
		throw new Error("invalid_capability");
	if (d.kind === "toolchain") validateToolchain(db, d, dependencies);
	else if (
		d.functionName !== undefined ||
		d.examples !== undefined ||
		d.packageRevisionId !== undefined ||
		d.artifact !== undefined ||
		d.redirects !== undefined ||
		d.bindingRevisionId !== undefined ||
		d.artifactRevisionId !== undefined ||
		d.minImpact !== undefined ||
		d.general !== undefined
	)
		throw new Error("invalid_capability");
	db.query("INSERT INTO capability_revisions VALUES(?,?,?,?,?,?)").run(
		rev,
		key,
		d.revision,
		JSON.stringify(d),
		digest,
		now(),
	);
	db.query(
		"INSERT INTO capability_items(key,id,kind,active_revision_id,origin) VALUES(?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET active_revision_id=excluded.active_revision_id,generation=generation+1",
	).run(key, d.id, d.kind, rev, origin);
	for (const dependency of d.dependencies)
		db.query("INSERT INTO capability_dependencies VALUES(?,?)").run(
			rev,
			dependency,
		);
	if (d.kind === "requirement" || resourceDefinitionKinds.includes(d.kind))
		return;
	indexSearch(db, d);
}
/** Replace the full-text entry of an item with the content of this revision. */
export function indexSearch(db: Database, d: Definition) {
	const key = `${d.kind}:${d.id}`;
	db.query("DELETE FROM capability_search WHERE key=?").run(key);
	db.query("INSERT INTO capability_search(key,content) VALUES(?,?)").run(
		key,
		[
			d.id,
			d.title,
			d.summary,
			...d.aliases,
			...d.tags,
			...d.useWhen,
			...(d.examples ?? []),
		].join(" "),
	);
}
/**
 * A toolchain is a fixed set: exactly one complete package (profile, SKILL, tools), a unique
 * function, how the conversation finds it, and an explicit result display.
 */
export function validateToolchain(
	db: Database,
	d: Definition,
	dependencies: FixedDefinition[],
) {
	const pack = dependencies[0];
	if (
		!d.functionName ||
		!toolchainFunctionPattern.test(d.functionName) ||
		[
			"find_toolchain",
			"task_control",
			"read_reference",
			"ask_user",
			"complete_task",
			"report_partial",
		].includes(d.functionName) ||
		// The conversation's read tools are the host's own, found by the same search.
		isReadToolName(d.functionName) ||
		!d.packageRevisionId ||
		d.dependencies.length !== 1 ||
		d.dependencies[0] !== d.packageRevisionId ||
		pack?.revisionId !== d.packageRevisionId ||
		pack.kind !== "package" ||
		!pack.profileRevisionId ||
		!pack.requiredSkillRevisionIds?.length ||
		!pack.toolRevisionIds ||
		!d.useWhen.length ||
		(d.examples?.length ?? 0) < 3 ||
		d.examples!.some((e) => !e.trim() || e.length > 200) ||
		invalidArtifact(d) ||
		(d.redirects ?? []).some((r) => !r.when.trim() || r.toolchainId === d.id) ||
		(d.minImpact !== undefined &&
			!(toolchainImpacts as readonly string[]).includes(d.minImpact)) ||
		(d.general !== undefined && d.general !== true)
	)
		throw new Error("invalid_toolchain");
	// Tools offered to a model take one flat object; a discriminator or union is never allowed.
	for (const tool of dependencies.filter((x) => x.kind === "tool"))
		if (tool.schemaKey && !flatObjectSchema(zSchema(tool.schemaKey)))
			throw new Error("invalid_toolchain_tool_schema");
	validateBinding(db, d, dependencies);
	if (
		(d.functionName === "execute_task") !==
		(d.bindingRevisionId !== undefined &&
			bindingInTransaction(db, d.bindingRevisionId)?.document.execution ===
				"task")
	)
		throw new Error("toolchain_function_conflict");
	const taken = db
		.query(
			"SELECT i.id FROM capability_items i JOIN capability_revisions r ON r.id=i.active_revision_id WHERE i.kind='toolchain' AND i.id<>? AND json_extract(r.definition_json,'$.functionName')=?",
		)
		.get(d.id, d.functionName);
	if (taken) throw new Error("toolchain_function_conflict");
}
/**
 * An unbound toolchain declares how its result is shown. A bound one is shown by its artifact
 * registration, so `artifact` is neither required nor used there.
 */
function invalidArtifact(d: Definition) {
	if (d.bindingRevisionId !== undefined) return false;
	return (
		!d.artifact ||
		(d.artifact.kind === "component" && !d.artifact.component.trim())
	);
}
/**
 * A bound toolchain names a stored command or session binding and the artifact it presents. Every tool
 * the binding connects must belong to the frozen package, with the binding's input schema equal
 * to the tool's own, so the model, the host and the UI validate the same shape.
 */
function validateBinding(
	db: Database,
	d: Definition,
	dependencies: FixedDefinition[],
) {
	if (d.bindingRevisionId === undefined && d.artifactRevisionId === undefined) {
		if (!dependencies[0]?.toolRevisionIds?.length)
			throw new Error("invalid_toolchain");
		return;
	}
	if (
		d.bindingRevisionId === undefined ||
		!bindingRevisionIdPattern.test(d.bindingRevisionId) ||
		(d.artifactRevisionId !== undefined &&
			!artifactRevisionIdPattern.test(d.artifactRevisionId))
	)
		throw new Error("invalid_toolchain");
	const binding = bindingInTransaction(db, d.bindingRevisionId);
	const pack = dependencies[0]!;
	if (!binding) throw new Error("invalid_toolchain");
	// A package without tools is only for a session agent working on a work document (spec §10).
	if (
		!pack.toolRevisionIds?.length &&
		binding.document.execution !== "task" &&
		binding.document.execution !== "pipeline" &&
		!(
			binding.document.execution === "session" &&
			binding.document.agent?.workspace
		)
	)
		throw new Error("invalid_toolchain");
	// An instant binding has no screen; every other binding is presented by exactly one artifact.
	if (
		binding.document.execution === "instant" ||
		binding.document.execution === "task" ||
		binding.document.execution === "pipeline"
	) {
		if (d.artifactRevisionId !== undefined)
			throw new Error("invalid_toolchain");
	} else if (
		d.artifactRevisionId === undefined ||
		binding.document.artifactRevisionId !== d.artifactRevisionId ||
		!artifactInTransaction(db, d.artifactRevisionId)
	)
		throw new Error("invalid_toolchain");
	const tools = new Set(pack.toolRevisionIds);
	for (const tool of binding.document.tools) {
		const fixed = dependencies.find(
			(x) => x.kind === "tool" && x.revisionId === tool.toolRevisionId,
		);
		if (
			!tools.has(tool.toolRevisionId) ||
			!fixed?.schemaKey ||
			tool.inputSchemaRef !== `builtin:${fixed.schemaKey}`
		)
			throw new Error("invalid_toolchain");
	}
}
/** A JSON Schema a model can fill directly: an object without top-level unions. */
function flatObjectSchema(schema: Record<string, unknown>) {
	return (
		schema.type === "object" &&
		!("oneOf" in schema) &&
		!("anyOf" in schema) &&
		!("allOf" in schema)
	);
}
