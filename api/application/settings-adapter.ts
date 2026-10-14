import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { z, ZodError } from "zod";
import type {
	ArtifactDefinitionV1,
	DocumentDescription,
	DocumentPathInfo,
	Capabilities,
	DocumentFieldV1,
} from "../domains/capabilities";
import type { SettingsService } from "../domains/settings";
import {
	asrLanguages,
	settingsSchema,
	type Settings,
} from "../domains/settings/contracts";
import type { AdapterResult, DomainAdapter } from "../domains/tool-runtime";

export const SETTINGS_ADAPTER_REF = "adapter:settings@1";
export const SETTINGS_DOCUMENT = "document:settings@1";
const DOCUMENT_QUERY = "query:settings.document@1";
const TTS_RESOURCES_QUERY = "query:settings.tts-resources@1";
const ASR_LANGUAGES_QUERY = "query:settings.asr-languages@1";
const APPLY_SCHEMA_REF = "schema:settings-apply@1";

/**
 * Field visibility conditions the Web counterpart evaluates (see `voice-presentation.ts`). The
 * local-voice conditions all imply that the local speech target is chosen; every one except
 * `speech-local` also implies that the LARM voice catalog lists the saved (or default) voice.
 */
export const settingsConditions = [
	/** The speech target being adjusted is the local (LARM) voice. */
	"condition:settings.speech-local@1",
	/** The selected local voice offers at least one style. */
	"condition:settings.larm-style@1",
	/** The selected local voice reports a speed range. */
	"condition:settings.larm-speed@1",
	/** The selected local voice reports a pitch range. */
	"condition:settings.larm-pitch@1",
	/** The selected local voice reports an intonation range (also gates automatic intonation). */
	"condition:settings.larm-intonation@1",
	/** `larm-intonation` and automatic intonation is on in the draft. */
	"condition:settings.larm-auto-strength@1",
	/** The browser can route playback to a chosen output device. */
	"condition:settings.output-device-selectable@1",
] as const;

// ---- fixed paths ---------------------------------------------------------------------------

type Segment = { key: string; selectById: boolean };

/** `$.a.b` / `$.resources[id=$target].voice` as segments, or null when not that shape. */
export function parseSettingsPath(path: string): Segment[] | null {
	if (!path.startsWith("$")) return null;
	const segments: Segment[] = [];
	for (const part of path.slice(1).split(".").slice(1)) {
		const match = /^([A-Za-z][A-Za-z0-9_]{0,40})(\[id=\$target\])?$/.exec(part);
		if (!match) return null;
		segments.push({ key: match[1]!, selectById: !!match[2] });
	}
	return path.startsWith("$.") && segments.length ? segments : null;
}

type Def = {
	type: string;
	innerType?: z.ZodType;
	element?: z.ZodType;
	shape?: Record<string, z.ZodType>;
};
const defOf = (schema: z.ZodType) => (schema as unknown as { def: Def }).def;
const WRAPPERS = ["optional", "nullable", "default", "prefault", "readonly"];
/** The schema under optional/nullable/default wrappers. */
function unwrap(schema: z.ZodType): z.ZodType {
	let current = schema;
	while (WRAPPERS.includes(defOf(current).type) && defOf(current).innerType)
		current = defOf(current).innerType!;
	return current;
}
const wrappedBy = (schema: z.ZodType, type: string) => {
	for (let s = schema; ; s = defOf(s).innerType!) {
		if (defOf(s).type === type) return true;
		if (!WRAPPERS.includes(defOf(s).type) || !defOf(s).innerType) return false;
	}
};
/** Values the host manages; no registered field may write them. */
const MANAGED_KEYS = new Set(["revision", "epoch", "id"]);

type LeafKind = "string" | "number" | "boolean" | "array";
type Leaf = {
	kind: LeafKind;
	schema: z.ZodType;
	optional: boolean;
	nullable: boolean;
	/** Segment keys that choose an array element by id, in path order. */
	selects: number;
};

/** The leaf a fixed path names in the settings schema, or null when the path is not a field. */
export function settingsLeaf(path: string): Leaf | null {
	const segments = parseSettingsPath(path);
	if (!segments) return null;
	let node: z.ZodType = settingsSchema;
	let leafSchema: z.ZodType | undefined;
	let selects = 0;
	for (const [index, { key, selectById }] of segments.entries()) {
		const object = unwrap(node);
		const shape = defOf(object).type === "object" ? defOf(object).shape : null;
		if (!shape || !Object.hasOwn(shape, key) || MANAGED_KEYS.has(key))
			return null;
		leafSchema = shape[key]!;
		node = leafSchema;
		if (selectById) {
			const array = unwrap(node);
			if (defOf(array).type !== "array" || !defOf(array).element) return null;
			node = defOf(array).element!;
			const element = unwrap(node);
			if (
				defOf(element).type !== "object" ||
				!Object.hasOwn(defOf(element).shape ?? {}, "id")
			)
				return null;
			selects++;
			if (index === segments.length - 1) return null;
		}
	}
	if (!leafSchema) return null;
	const inner = unwrap(leafSchema);
	const type = defOf(inner).type;
	let kind: LeafKind;
	if (type === "string" || type === "enum") kind = "string";
	else if (type === "number") kind = "number";
	else if (type === "boolean") kind = "boolean";
	else if (type === "array") {
		const element = defOf(inner).element && unwrap(defOf(inner).element!);
		if (!element || !["string", "enum"].includes(defOf(element).type))
			return null;
		kind = "array";
	} else return null;
	return {
		kind,
		schema: leafSchema,
		optional: wrappedBy(leafSchema, "optional"),
		nullable: wrappedBy(leafSchema, "nullable"),
		selects,
	};
}

const finite = (value: number | null | undefined) =>
	typeof value === "number" && Math.abs(value) < Number.MAX_SAFE_INTEGER
		? value
		: undefined;

/** What the settings schema says about a registered path (kind, bounds, optional, nullable). */
export function describeSettingsPath(path: string): DocumentPathInfo | null {
	const leaf = settingsLeaf(path);
	if (!leaf) return null;
	const inner = unwrap(leaf.schema) as unknown as {
		options?: string[];
		minValue?: number | null;
		maxValue?: number | null;
		format?: string | null;
		maxLength?: number | null;
		minLength?: number | null;
		def: Def;
	};
	const common = { optional: leaf.optional, nullable: leaf.nullable };
	if (leaf.kind === "boolean") return { kind: "boolean", ...common };
	if (leaf.kind === "number") {
		const min = finite(inner.minValue);
		const max = finite(inner.maxValue);
		return {
			kind: inner.format === "safeint" ? "integer" : "number",
			...(min !== undefined ? { min } : {}),
			...(max !== undefined ? { max } : {}),
			...common,
		};
	}
	if (leaf.kind === "array") {
		const element = unwrap(
			defOf(inner as unknown as z.ZodType).element!,
		) as unknown as {
			options?: string[];
		};
		return {
			kind: "array",
			...(element.options ? { values: [...element.options] } : {}),
			...common,
		};
	}
	if (defOf(inner as unknown as z.ZodType).type === "enum")
		return { kind: "enum", values: [...(inner.options ?? [])], ...common };
	const maxLength = finite(inner.maxLength);
	return {
		kind: "string",
		...(maxLength !== undefined ? { maxLength } : {}),
		...common,
	};
}

/** `[id=$target]` paths list their targets with the TTS models query (the only array so far). */
function settingsTargetQuery(path: string): string | null {
	return parseSettingsPath(path)?.[0]?.key === "resources" &&
		settingsLeaf(path)?.selects
		? TTS_RESOURCES_QUERY
		: null;
}

// ---- operation input -----------------------------------------------------------------------

const fieldId = z.string().regex(/^[a-z][a-z0-9.-]{0,80}$/);
/**
 * Wire values are strings (booleans "true"/"false", numbers in decimal, arrays as a JSON array
 * of strings), as every OpenUI event value is; the registered path's schema decides the type.
 */
const change = z
	.strictObject({
		fieldId,
		target: z.uuid().optional(),
		value: z.string().max(4096).optional(),
		unset: z.literal(true).optional(),
	})
	.refine((c) => (c.value === undefined) !== (c.unset === undefined), {
		message: "value_or_unset",
	});
const key = z
	.strictObject({
		connectionId: z.uuid(),
		value: z.string().min(1).max(4096).optional(),
		delete: z.literal(true).optional(),
	})
	.refine((k) => (k.value === undefined) !== (k.delete === undefined), {
		message: "value_or_delete",
	});
export const settingsApplyInput = z.strictObject({
	expectedRevision: z.number().int().min(0),
	changes: z.array(change).min(1).max(64),
	keys: z.array(key).max(32).optional(),
});

/** What the adapter needs to know about a registered field. */
export type SettingsField = Pick<
	DocumentFieldV1,
	"fieldId" | "document" | "path" | "unset"
>;
/** The registered fields of the settings document: supplied by the host's capabilities. */
export type SettingsFieldLookup = (
	tx: Database,
	fieldId: string,
) => SettingsField | undefined;

/** Fields registered on published artifacts, looked up by field id. */
export function publishedSettingsFields(
	capabilities: () => Pick<
		Capabilities,
		"artifactsInTransaction" | "documentInTransaction"
	>,
): SettingsFieldLookup {
	return (tx, id) => {
		const reads = capabilities();
		for (const entry of reads.artifactsInTransaction(tx)) {
			const document = reads.documentInTransaction(tx, entry.artifactRevisionId)
				?.document as Partial<ArtifactDefinitionV1> | undefined;
			const found = document?.fields?.find((f) => f.fieldId === id);
			if (found) return found;
		}
		return undefined;
	};
}

function decode(leaf: Leaf, wire: string): unknown {
	if (leaf.kind === "string") return wire;
	if (leaf.kind === "boolean") {
		if (wire !== "true" && wire !== "false") throw new Error("invalid_value");
		return wire === "true";
	}
	if (leaf.kind === "number") {
		const value = Number(wire);
		if (!wire.trim() || !Number.isFinite(value))
			throw new Error("invalid_value");
		return value;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(wire);
	} catch {
		throw new Error("invalid_value");
	}
	if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== "string"))
		throw new Error("invalid_value");
	return parsed;
}

/** Put `value` at the path of `settings` (array elements chosen by id); `undefined` deletes. */
function writeAt(
	settings: Settings,
	segments: Segment[],
	target: string | undefined,
	apply: (container: Record<string, unknown>, key: string) => void,
) {
	let container = settings as unknown as Record<string, unknown>;
	for (const [index, { key, selectById }] of segments.entries()) {
		if (index === segments.length - 1) {
			apply(container, key);
			return;
		}
		const next = container[key];
		if (selectById) {
			const element = Array.isArray(next)
				? (next as Record<string, unknown>[]).find((e) => e.id === target)
				: undefined;
			if (!element) throw new Error("target_not_found");
			container = element;
		} else if (next && typeof next === "object" && !Array.isArray(next))
			container = next as Record<string, unknown>;
		else throw new Error("path_not_found");
	}
}

/** The saved document with the changes applied; every rejection is a safe error code. */
export function applyChanges(
	saved: Settings,
	changes: z.infer<typeof settingsApplyInput>["changes"],
	lookup: (id: string) => SettingsField | undefined,
	targets: (query: string) => ReadonlySet<string>,
): Settings {
	const next = structuredClone(saved);
	const seen = new Set<string>();
	for (const item of changes) {
		const field = lookup(item.fieldId);
		if (!field || field.document !== SETTINGS_DOCUMENT)
			throw new Error("field_not_registered");
		const segments = parseSettingsPath(field.path);
		const leaf = settingsLeaf(field.path);
		if (!segments || !leaf) throw new Error("field_not_registered");
		if (leaf.selects ? !item.target : item.target)
			throw new Error("target_invalid");
		if (item.target) {
			// Only the targets the field's registered query lists, not any element of the array.
			const query = settingsTargetQuery(field.path);
			if (!query) throw new Error("target_invalid");
			if (!targets(query).has(item.target)) throw new Error("target_not_found");
		}
		const slot = `${item.fieldId}:${item.target ?? ""}`;
		if (seen.has(slot)) throw new Error("duplicate_change");
		seen.add(slot);
		if (item.unset) {
			if (
				!field.unset ||
				(field.unset === "delete-key" && !leaf.optional) ||
				(field.unset === "null" && !leaf.nullable) ||
				(field.unset === "empty-string" && leaf.kind !== "string")
			)
				throw new Error("unset_not_allowed");
			writeAt(next, segments, item.target, (container, name) => {
				if (field.unset === "delete-key") delete container[name];
				else container[name] = field.unset === "null" ? null : "";
			});
		} else {
			const value = decode(leaf, item.value!);
			writeAt(next, segments, item.target, (container, name) => {
				container[name] = value;
			});
		}
	}
	return next;
}

/**
 * The TTS models as targets: `label` names the model ("接続名 / モデル") and `selectLabel` is the
 * speech-target choice with its assignment state.
 */
function ttsTargets(current: Settings, query: string) {
	if (query !== TTS_RESOURCES_QUERY) return [];
	return current.resources
		.filter((r) => r.purpose === "tts")
		.map((r) => {
			const connection =
				current.connections.find((c) => c.id === r.connectionId)?.name ??
				"登録モデル";
			const assigned = current.routes.tts.fallbackId === r.id;
			return {
				id: r.id,
				label: `${connection} / ${r.model}`,
				selectLabel: `${connection} / ${r.model}${assigned ? "（割当済み）" : "（未割当）"}`,
				connection,
				model: r.model,
				assigned,
			};
		});
}

// ---- adapter -------------------------------------------------------------------------------

const sha256 = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** What the settings adapter offers, without a settings service (bundle checks, evaluation). */
export const describeSettingsAdapter = () => ({
	owner: "settings",
	operations: new Map([
		[
			"settings.apply",
			{ inputSchemaRef: APPLY_SCHEMA_REF, effect: "write" as const },
		],
	]),
	queries: new Set([DOCUMENT_QUERY, TTS_RESOURCES_QUERY, ASR_LANGUAGES_QUERY]),
	inputAdapters: new Map(),
	projections: new Set<string>(),
	availability: "availability:settings@1",
	documents: new Map([
		[
			SETTINGS_DOCUMENT,
			{
				describePath: describeSettingsPath,
				targetQuery: settingsTargetQuery,
			} satisfies DocumentDescription,
		],
	]),
	conditions: new Set<string>(settingsConditions),
});

export type SettingsAdapterPorts = Pick<
	SettingsService,
	"inTransaction" | "applyInTransaction" | "notifyChanged"
>;

/**
 * The typed settings adapter. The settings domain keeps storage, encryption, revision,
 * connection epochs and request replay; this adapter only turns registered field changes into
 * the whole document and hands it to the domain's `applyInTransaction`. Settings are never
 * changed from a conversation.
 */
export function createSettingsAdapter(
	settings: SettingsAdapterPorts,
	options: { fields: SettingsFieldLookup },
): DomainAdapter {
	return {
		ref: SETTINGS_ADAPTER_REF,
		describe: describeSettingsAdapter,
		availableInTransaction: () => true,
		snapshotInTransaction: () => ({ items: [] }),
		invokeInTransaction(tx, request): AdapterResult {
			if (
				request.origin.kind !== "ui" ||
				request.operationName !== "settings.apply"
			)
				throw new Error("capability_unavailable");
			const parsed = settingsApplyInput.safeParse(request.input);
			if (!parsed.success) throw new Error("invalid_input");
			const input = parsed.data;
			const saved = settings.inTransaction(tx);
			let document: Settings;
			try {
				document = applyChanges(
					saved,
					input.changes,
					(id) => options.fields(tx, id),
					(query) =>
						new Set(ttsTargets(saved, query).map((target) => target.id)),
				);
			} catch (error) {
				// A stale draft names what may no longer exist: report the conflict first.
				if (saved.revision !== input.expectedRevision)
					throw new Error("revision_conflict");
				throw error;
			}
			// A replayed request carries the revision it was first sent against.
			document.revision = input.expectedRevision;
			const valid = settingsSchema.safeParse(document);
			if (!valid.success) {
				if (saved.revision !== input.expectedRevision)
					throw new Error("revision_conflict");
				throw new Error("invalid_settings");
			}
			let applied: ReturnType<SettingsAdapterPorts["applyInTransaction"]>;
			try {
				applied = settings.applyInTransaction(tx, {
					requestId: request.requestId,
					expectedRevision: input.expectedRevision,
					settings: valid.data,
					keys: (input.keys ?? []).map((k) => ({
						connectionId: k.connectionId,
						value: k.delete ? null : k.value!,
					})),
				});
			} catch (error) {
				if (error instanceof ZodError) throw new Error("invalid_settings");
				throw error;
			}
			// Field ids and revision only: neither values nor secrets enter the receipt.
			const receipt = {
				version: 1,
				requestId: request.requestId,
				revision: applied.settings.revision,
				changed: input.changes.map((c) => ({
					fieldId: c.fieldId,
					...(c.target ? { target: c.target } : {}),
				})),
				keys: input.keys?.length ?? 0,
			};
			return {
				receipt,
				receiptRef: {
					owner: "settings",
					operationId: request.requestId,
					digest: sha256(receipt),
				},
				resultRefs: [
					{
						owner: "settings",
						kind: "settings",
						id: "document",
						schemaRef: "domain:settings.document@1",
						revision: applied.settings.revision,
					},
				],
				replay: applied.replay,
			};
		},
		// The saved document is the receipt: the confirmed revision is in the result reference.
		readInTransaction: () => null,
		sourceInTransaction(tx, query) {
			const current = settings.inTransaction(tx);
			if (query === DOCUMENT_QUERY)
				return {
					revision: current.revision,
					data: { revision: current.revision, settings: current },
				};
			if (query === TTS_RESOURCES_QUERY)
				return {
					revision: current.revision,
					data: {
						localAvailable: current.routes.tts.mode !== "cloud-only",
						targets: ttsTargets(current, query),
					},
				};
			if (query === ASR_LANGUAGES_QUERY)
				return {
					revision: current.revision,
					data: {
						options: asrLanguages.map(([value, label]) => ({ value, label })),
					},
				};
			return null;
		},
		targetInput: () => ({}),
		afterCommit: () => settings.notifyChanged(),
	};
}
