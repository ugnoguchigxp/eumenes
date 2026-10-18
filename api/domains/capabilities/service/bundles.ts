import type { Database } from "bun:sqlite";
import { z } from "zod";
import { getLogger } from "../../../infrastructure/logger";
import {
	bytes,
	artifactDefinitionV1,
	capabilityBundleV1,
	hash,
	validators,
	type ArtifactDefinitionV1,
	type BindingV1,
	type BundleHost,
	type BundleIssue,
	type CapabilityBundleV1,
	type Definition,
} from "../contracts";
import { getDocument, insertDocument, type DocumentKind } from "../repository";
import { publishedArtifacts, publishRegisteredArtifact } from "./artifacts";
import { checkCollections } from "./bundle-collections";
import {
	checkActionTargets,
	checkFields,
	claimField,
	schemaProperties,
} from "./bundle-fields";
import { bundleFiles } from "./bundle-files";
import {
	compileJsonSchemaSubset,
	UnsupportedSchema,
} from "./json-schema-subset";

const kinds = [
	"package",
	"profile",
	"skill",
	"tool",
	"requirement",
	"toolchain",
];
const text = z.string().max(20_000);
const textList = z.array(text).max(64);
/** The fields every definition carries; the registry checks the rest by kind. */
const definitionShape = z.looseObject({
	kind: z.enum(kinds as [string, ...string[]]),
	id: z.string(),
	revision: z.number().int(),
	title: text,
	summary: text,
	aliases: textList,
	tags: textList,
	useWhen: textList,
	avoidWhen: textList,
	dependencies: z.array(z.string()).max(64),
});
/** Errors the registry throws, as the reason a bundle is refused. */
const registryCodes: Record<string, BundleIssue["code"]> = {
	invalid_toolchain: "invalid_toolchain",
	toolchain_function_conflict: "duplicate_function",
	capability_revision_conflict: "revision_conflict",
	capability_unavailable: "unavailable",
	capability_cycle: "dependency_cycle",
	invalid_capability_schema: "schema_mismatch",
	invalid_toolchain_tool_schema: "unsupported_schema",
};

type Parsed = CapabilityBundleV1;
type CommandBinding = Extract<BindingV1, { execution: "command" }>;
type SessionBinding = Extract<BindingV1, { execution: "session" }>;
type InstantBinding = Extract<BindingV1, { execution: "instant" }>;
type Doc = {
	kind: DocumentKind;
	itemId: string;
	revision: number;
	revisionId: string;
	document: unknown;
	path: string;
};

const revisionOf = (d: { kind: string; id: string; revision: number }) =>
	`${d.kind}:${d.id}@${d.revision}`;

/** Every source name a presentation definition refers to. */
function definitionSources(node: unknown, out = new Set<string>()) {
	if (Array.isArray(node)) node.forEach((x) => definitionSources(x, out));
	else if (node && typeof node === "object")
		for (const [key, value] of Object.entries(node))
			if (key === "source" && typeof value === "string") out.add(value);
			else definitionSources(value, out);
	return out;
}

type Adapter = NonNullable<ReturnType<BundleHost["adapters"]["get"]>>;
type Entry = { d: Definition; path: string };
type Issue = (code: BundleIssue["code"], path: string, ref?: string) => void;
/** What every check reads: the bundle, what the host can run and what is already stored. */
export type Check = {
	db: Database;
	host: BundleHost;
	bundle: Parsed;
	issue: Issue;
	definitions: Entry[];
	docs: Doc[];
	storedRevision: (id: string) => boolean;
	hasRevision: (id: string) => boolean;
	hasDocument: (id: string, kind: DocumentKind) => boolean;
	schemaRef: (ref: string, path: string) => void;
	schemaResolves: (ref: string) => boolean;
	/** Who registered each field id and (document, path): the published catalog plus this bundle. */
	fieldClaims: Map<string, { artifactId: string; revision: number }>;
	/** Documents with a confidential field anywhere in the catalog (published or this bundle). */
	confidentialDocs: Set<string>;
};

function collectDocs(bundle: Parsed): Doc[] {
	return [
		...bundle.schemas.map((s, i) => ({
			kind: "schema" as const,
			itemId: s.id,
			revision: s.revision,
			revisionId: `schema:${s.id}@${s.revision}`,
			document: s,
			path: `schemas/${i}`,
		})),
		...bundle.bindings.map((b, i) => ({
			kind: "binding" as const,
			itemId: b.id,
			revision: b.revision,
			revisionId: `binding:${b.id}@${b.revision}`,
			document: b,
			path: `bindings/${i}`,
		})),
		...bundle.artifacts.map((a, i) => ({
			kind: "artifact" as const,
			itemId: a.id,
			revision: a.revision,
			revisionId: `artifact:${a.id}@${a.revision}`,
			document: a,
			path: `artifacts/${i}`,
		})),
	];
}

function createCheck(
	db: Database,
	host: BundleHost,
	bundle: Parsed,
	issue: Issue,
): Check {
	const definitions: Entry[] = [];
	bundle.definitions.forEach((raw, i) => {
		if (!definitionShape.safeParse(raw).success)
			issue("invalid_format", `definitions/${i}`);
		else definitions.push({ d: raw as Definition, path: `definitions/${i}` });
	});
	const docs = collectDocs(bundle);
	// What the bundle itself offers, next to what is already stored.
	const bundleDefinitions = new Set<string>();
	for (const { d, path } of definitions) {
		const id = revisionOf(d);
		if (bundleDefinitions.has(id)) issue("revision_conflict", path, id);
		bundleDefinitions.add(id);
	}
	const bundleDocs = new Map<string, Doc>();
	for (const doc of docs) {
		if (bundleDocs.has(doc.revisionId))
			issue("revision_conflict", doc.path, doc.revisionId);
		bundleDocs.set(doc.revisionId, doc);
	}
	const storedRevision = (id: string) =>
		!!db.query("SELECT 1 FROM capability_revisions WHERE id=?").get(id);
	const hasDocument = (id: string, kind: DocumentKind) =>
		(bundleDocs.get(id)?.kind ?? getDocument(db, id)?.kind) === kind;
	const schemaResolves = (ref: string) => {
		if (ref.startsWith("builtin:"))
			return Object.hasOwn(validators, ref.slice("builtin:".length));
		if (ref.startsWith("domain:")) return host.domainSchemas.has(ref);
		return hasDocument(ref, "schema");
	};
	// Artifacts of this bundle replace the published revisions of the same ids.
	const bundleArtifacts = new Set(bundle.artifacts.map((a) => a.id));
	const published = publishedArtifacts(db);
	const fieldClaims = new Map<
		string,
		{ artifactId: string; revision: number }
	>();
	const confidentialDocs = new Set<string>();
	const catalog = [
		...published
			.map((p) => p.document)
			.filter((a) => !bundleArtifacts.has(a.id)),
		...bundle.artifacts,
	];
	for (const a of catalog)
		for (const f of a.fields ?? [])
			if (f.confidential) confidentialDocs.add(f.document);
	for (const { document } of published)
		if (!bundleArtifacts.has(document.id))
			for (const f of document.fields ?? [])
				claimField(fieldClaims, f, document.id, document.revision);
	return {
		db,
		host,
		bundle,
		issue,
		fieldClaims,
		confidentialDocs,
		definitions,
		docs,
		storedRevision,
		hasRevision: (id) => bundleDefinitions.has(id) || storedRevision(id),
		hasDocument,
		schemaResolves,
		schemaRef: (ref, path) => {
			if (!schemaResolves(ref)) issue("unknown_reference", path, ref);
		},
	};
}

/** Pins: the exact stored digests the bundle was reviewed against. */
function checkPins({ db, bundle, issue }: Check) {
	bundle.pins.forEach((pin, i) => {
		const row = db
			.query("SELECT definition_hash FROM capability_revisions WHERE id=?")
			.get(pin.revisionId) as { definition_hash: string } | null;
		if (!row) issue("unknown_reference", `pins/${i}`, pin.revisionId);
		else if (row.definition_hash !== pin.digest)
			issue("digest_mismatch", `pins/${i}`, pin.revisionId);
	});
}

/** A stored id never changes its digest; schemas must stay inside the finite subset. */
function checkDocuments({ db, bundle, docs, issue }: Check) {
	for (const doc of docs) {
		const stored = getDocument(db, doc.revisionId);
		if (stored && stored.digest !== hash(doc.document))
			issue("revision_conflict", doc.path, doc.revisionId);
	}
	bundle.schemas.forEach((s, i) => {
		try {
			compileJsonSchemaSubset(s.schema);
		} catch (e) {
			if (!(e instanceof UnsupportedSchema)) throw e;
			issue("unsupported_schema", `schemas/${i}${e.path}`, e.reason);
		}
	});
}

function checkTool(
	c: Check,
	tool: BindingV1["tools"][number],
	adapter: Adapter | undefined,
	seen: Set<string>,
	at: string,
) {
	const { issue } = c;
	if (!c.hasRevision(tool.toolRevisionId))
		issue("unknown_reference", `${at}/toolRevisionId`, tool.toolRevisionId);
	if (seen.has(tool.toolRevisionId))
		issue("invalid_format", `${at}/toolRevisionId`, tool.toolRevisionId);
	seen.add(tool.toolRevisionId);
	c.schemaRef(tool.inputSchemaRef, `${at}/inputSchemaRef`);
	if (!adapter) return;
	const operation = adapter.operations.get(tool.operationId);
	if (!operation)
		issue("unregistered_operation", `${at}/operationId`, tool.operationId);
	else if (operation.inputSchemaRef !== tool.inputSchemaRef)
		issue("schema_mismatch", `${at}/inputSchemaRef`, tool.inputSchemaRef);
}

/** Question schemas must be readable validators; the choice field must be one of their fields. */
function checkQuestions(
	c: Check,
	questions: NonNullable<CommandBinding["questions"]>,
	path: string,
) {
	const seen = new Set<string>();
	questions.forEach((q, k) => {
		const at = `${path}/questions/${k}`;
		const ref = q.inputSchemaRef;
		if (ref === "builtin:answerText" || seen.has(ref))
			c.issue("invalid_format", `${at}/inputSchemaRef`, ref);
		seen.add(ref);
		if (ref.startsWith("domain:") || !c.schemaResolves(ref))
			return c.issue("unknown_reference", `${at}/inputSchemaRef`, ref);
		if (q.choiceField === undefined) return;
		if (!schemaProperties(c, ref)?.includes(q.choiceField))
			c.issue("schema_mismatch", `${at}/choiceField`, q.choiceField);
	});
}

/** What a binding of either execution names: adapter, availability, artifact and its tools. */
function checkBindingBase(c: Check, b: BindingV1, path: string) {
	const { host, issue } = c;
	const adapter = host.adapters.get(b.adapterRef);
	if (!adapter)
		issue("unregistered_adapter", `${path}/adapterRef`, b.adapterRef);
	if (!host.availability.has(b.availabilityRef))
		issue("unavailable", `${path}/availabilityRef`, b.availabilityRef);
	if (
		b.execution !== "instant" &&
		!c.hasDocument(b.artifactRevisionId, "artifact")
	)
		issue(
			"unknown_reference",
			`${path}/artifactRevisionId`,
			b.artifactRevisionId,
		);
	const seen = new Set<string>();
	b.tools.forEach((tool, j) =>
		checkTool(c, tool, adapter, seen, `${path}/tools/${j}`),
	);
}

function checkCommandBinding(c: Check, b: CommandBinding, path: string) {
	const { host, issue } = c;
	if (!host.projections.has(b.resultProjectionRef))
		issue(
			"unregistered_projection",
			`${path}/resultProjectionRef`,
			b.resultProjectionRef,
		);
	c.schemaRef(b.outputSchemaRef, `${path}/outputSchemaRef`);
	checkQuestions(c, b.questions ?? [], path);
	checkTaskRetries(c, b, path);
	checkBindingBase(c, b, path);
}

/**
 * The retries of the single-shot task a command starts name tools of this binding (the package tool's id
 * is the part of its revision id between `tool:` and `@`), or `default`.
 */
function checkTaskRetries(c: Check, b: CommandBinding, path: string) {
	const retries = b.agent?.turn.retries;
	if (!retries) return;
	const ids = new Set(
		b.tools.map((tool) => tool.toolRevisionId.slice(5).split("@")[0]),
	);
	for (const key of Object.keys(retries))
		if (key !== "default" && !ids.has(key))
			c.issue("unknown_reference", `${path}/agent/turn/retries/${key}`, key);
}

/**
 * A session binding has no output or projection; its target schema (if any) must resolve, the work document
 * its agent names must be one the adapter declares, and the agent needs something to work with: a tool or a
 * work document. Shared tools name toolchains, looked up when they are called (bundles register in file order).
 */
function checkSessionBinding(c: Check, b: SessionBinding, path: string) {
	if (b.session.targetSchemaRef)
		c.schemaRef(b.session.targetSchemaRef, `${path}/session/targetSchemaRef`);
	const workspace = b.agent?.workspace?.documentRef;
	if (
		workspace &&
		!c.host.adapters.get(b.adapterRef)?.workspaces?.has(workspace)
	)
		c.issue(
			"unknown_reference",
			`${path}/agent/workspace/documentRef`,
			workspace,
		);
	if (!b.tools.length && !workspace)
		c.issue("invalid_format", `${path}/tools`, "tools or agent.workspace");
	const shared = new Set<string>();
	b.agent?.sharedTools?.forEach((tool, j) => {
		if (shared.has(tool.as))
			c.issue("invalid_format", `${path}/agent/sharedTools/${j}/as`, tool.as);
		shared.add(tool.as);
	});
	checkBindingBase(c, b, path);
}

/**
 * An instant binding names the adapter's operation for its one tool. The toolchain it falls back to is looked
 * up when the answer fails, not here: bundles are registered in file order, so it may be registered later.
 */
function checkInstantBinding(c: Check, b: InstantBinding, path: string) {
	checkBindingBase(c, b, path);
	const adapter = c.host.adapters.get(b.adapterRef);
	if (adapter && !adapter.instant)
		c.issue("unregistered_adapter", `${path}/adapterRef`, b.adapterRef);
}

type Artifact = z.infer<typeof artifactDefinitionV1>;

/** Source name to its adapter, for the sources whose adapter and query the host runs. */
function checkSources(c: Check, a: Artifact, path: string) {
	const adapterOf = new Map<string, string>();
	a.sourceBindings.forEach((s, j) => {
		const at = `${path}/sourceBindings/${j}`;
		const adapter = c.host.adapters.get(s.adapterRef);
		if (!adapter)
			return c.issue("unregistered_adapter", `${at}/adapterRef`, s.adapterRef);
		adapterOf.set(s.source, s.adapterRef);
		if (!adapter.queries.has(s.query))
			c.issue("unregistered_query", `${at}/query`, s.query);
		if (s.paramsSchemaRef)
			c.schemaRef(s.paramsSchemaRef, `${at}/paramsSchemaRef`);
	});
	return adapterOf;
}

function checkActions(
	c: Check,
	a: Artifact,
	path: string,
	adapterOf: Map<string, string>,
) {
	const { host, issue } = c;
	const events = new Set<string>();
	a.actionBindings.forEach((action, j) => {
		const at = `${path}/actionBindings/${j}`;
		const key = `${action.source}\n${action.eventAction}`;
		if (events.has(key))
			issue("invalid_format", `${at}/eventAction`, action.eventAction);
		events.add(key);
		c.schemaRef(action.inputSchemaRef, `${at}/inputSchemaRef`);
		if (
			action.inputAdapterRef &&
			!host.inputAdapters.has(action.inputAdapterRef)
		)
			issue(
				"unregistered_input_adapter",
				`${at}/inputAdapterRef`,
				action.inputAdapterRef,
			);
		const sent = action.effect === "write";
		if (!sent && (action.operationId || action.answer))
			issue("invalid_format", at);
		checkActionTargets(
			c,
			action,
			at,
			host.adapters.get(adapterOf.get(action.source) ?? ""),
			a.id,
		);
	});
}

function checkVariants(
	c: Check,
	a: Artifact,
	path: string,
	adapterOf: Map<string, string>,
) {
	const variants = new Set<string>();
	a.variants.forEach((v, j) => {
		const at = `${path}/variants/${j}`;
		if (variants.has(v.id)) c.issue("invalid_format", `${at}/id`, v.id);
		variants.add(v.id);
		for (const key of ["definition", "questionDefinition"] as const) {
			const definition = v[key];
			if (definition === undefined) continue;
			if (
				!definition ||
				typeof definition !== "object" ||
				bytes(definition) > 16_384
			) {
				c.issue("invalid_format", `${at}/${key}`);
				continue;
			}
			for (const source of definitionSources(definition))
				if (!adapterOf.has(source))
					c.issue("unknown_reference", `${at}/${key}`, source);
		}
	});
}

function checkBindingsAndArtifacts(c: Check) {
	c.bundle.bindings.forEach((b, i) =>
		b.execution === "session"
			? checkSessionBinding(c, b, `bindings/${i}`)
			: b.execution === "instant"
				? checkInstantBinding(c, b, `bindings/${i}`)
				: checkCommandBinding(c, b, `bindings/${i}`),
	);
	c.bundle.artifacts.forEach((a, i) => {
		const path = `artifacts/${i}`;
		const adapterOf = checkSources(c, a, path);
		checkActions(c, a, path, adapterOf);
		checkFields(c, a, path);
		checkCollections(c, a, path);
		checkVariants(c, a, path, adapterOf);
	});
}

/** Dependencies first; cycles and unknown dependencies are refused. */
function orderDefinitions(c: Check): Entry[] {
	const order: Entry[] = [];
	const state = new Map<string, "visiting" | "done" | "bad">();
	const visit = (entry: Entry): boolean => {
		const id = revisionOf(entry.d);
		const current = state.get(id);
		if (current === "done") return true;
		if (current === "bad") return false;
		if (current === "visiting") {
			c.issue("dependency_cycle", entry.path, id);
			state.set(id, "bad");
			return false;
		}
		state.set(id, "visiting");
		let ok = true;
		for (const dep of entry.d.dependencies) {
			const inBundle = c.definitions.find((x) => revisionOf(x.d) === dep);
			if (inBundle) {
				if (!visit(inBundle)) ok = false;
			} else if (!c.storedRevision(dep)) {
				c.issue("unknown_reference", entry.path, dep);
				ok = false;
			}
		}
		state.set(id, ok ? "done" : "bad");
		if (ok) order.push(entry);
		return ok;
	};
	c.definitions.forEach(visit);
	return order;
}

/** Documents first, then each definition in its own savepoint so every refusal is listed. */
function registerAll(
	c: Check,
	order: Entry[],
	deps: {
		register: (db: Database, d: Definition) => void;
		now: () => number;
	},
) {
	const { db } = c;
	const registered: string[] = [];
	for (const doc of c.docs) {
		if (getDocument(db, doc.revisionId)) continue;
		insertDocument(db, {
			revisionId: doc.revisionId,
			kind: doc.kind,
			itemId: doc.itemId,
			revision: doc.revision,
			digest: hash(doc.document),
			document: doc.document,
			bundleId: c.bundle.bundleId,
			createdAtMs: deps.now(),
		});
		registered.push(doc.revisionId);
		if (doc.kind === "artifact")
			publishRegisteredArtifact(
				db,
				doc.document as ArtifactDefinitionV1,
				doc.revisionId,
				deps.now(),
			);
	}
	for (const { d, path } of order) {
		const id = revisionOf(d);
		const fresh = !c.storedRevision(id);
		db.exec("SAVEPOINT capability_bundle_definition");
		try {
			deps.register(db, d);
			db.exec("RELEASE capability_bundle_definition");
			if (fresh) registered.push(id);
		} catch (e) {
			db.exec("ROLLBACK TO capability_bundle_definition");
			db.exec("RELEASE capability_bundle_definition");
			const reason = e instanceof Error ? e.message : "unknown";
			c.issue(registryCodes[reason] ?? "invalid_format", path, id);
		}
	}
	return registered;
}

export function createBundles(deps: {
	register: (db: Database, d: Definition) => void;
	now: () => number;
}) {
	function importBundleInTransaction(
		db: Database,
		raw: unknown,
		host: BundleHost,
		options: { dryRun?: boolean } = {},
	): { issues: BundleIssue[]; registered: string[] } {
		const dryRun = options.dryRun === true;
		const done = (issues: BundleIssue[], registered: string[]) => {
			if (issues.length && !dryRun)
				throw new Error("invalid_capability_bundle");
			return { issues, registered };
		};
		const parsed = capabilityBundleV1.safeParse(raw);
		if (!parsed.success)
			return done(
				parsed.error.issues.map((i) => ({
					code: "invalid_format" as const,
					path: i.path.join("/"),
				})),
				[],
			);
		const issues: BundleIssue[] = [];
		const c = createCheck(db, host, parsed.data, (code, path, ref) =>
			issues.push(ref === undefined ? { code, path } : { code, path, ref }),
		);
		checkPins(c);
		checkDocuments(c);
		checkBindingsAndArtifacts(c);
		const order = orderDefinitions(c);
		// Register for real inside a savepoint: the registry is the one place that judges a
		// definition, and everything is rolled back unless the bundle is clean and not a dry run.
		let registered: string[];
		db.exec("SAVEPOINT capability_bundle");
		try {
			registered = registerAll(c, order, deps);
		} catch (e) {
			db.exec("ROLLBACK TO capability_bundle");
			db.exec("RELEASE capability_bundle");
			throw e;
		}
		if (dryRun || issues.length) db.exec("ROLLBACK TO capability_bundle");
		db.exec("RELEASE capability_bundle");
		return done(issues, registered);
	}

	/**
	 * Register the reviewed bundles of the repository. A bundle the host cannot run (a missing
	 * adapter, an unavailable runtime) is skipped whole and logged; it never fails startup.
	 */
	function seedBundlesInTransaction(
		db: Database,
		host: BundleHost | undefined,
	) {
		for (const { name, raw } of bundleFiles()) {
			const log = (reason: string, count?: number) =>
				getLogger("capabilities").warn("capability.bundle_skipped", {
					subjectId: name,
					reason,
					...(count === undefined ? {} : { issueCount: count }),
				});
			if (!host) {
				log("no_bundle_host");
				continue;
			}
			const result = importBundleInTransaction(db, raw, host, {
				dryRun: true,
			});
			if (result.issues.length) {
				log(result.issues[0]!.code, result.issues.length);
				continue;
			}
			importBundleInTransaction(db, raw, host);
		}
	}
	return { importBundleInTransaction, seedBundlesInTransaction };
}
