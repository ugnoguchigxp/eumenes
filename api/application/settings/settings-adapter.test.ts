import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCapabilities } from "../../domains/capabilities";
import {
	createActionRequests,
	createAdapterRegistry,
} from "../../domains/tool-runtime";
import { createSettings } from "../../domains/settings";
import { type Settings } from "../../domains/settings/contracts";
import { openStore, type SqliteStore } from "../../infrastructure/sqlite";
import { migrations } from "../migrations";
import {
	createSettingsAdapter,
	describeSettingsAdapter,
	describeSettingsPath,
	publishedSettingsFields,
	settingsConditions,
	settingsLeaf,
	type SettingsField,
} from "./settings-adapter";
import { createInferenceAdapter } from "./inference-adapter";
import { offlineBundleHost } from "../toolchain/toolchain-adapters";

type BundleField = SettingsField & { visibleWhen?: string };
const bundle = JSON.parse(
	readFileSync(
		join(
			import.meta.dir,
			"../../domains/capabilities/bundles/settings.bundle.json",
		),
		"utf8",
	),
) as { artifacts: Array<{ id: string; fields?: BundleField[] }> };
const registered = new Map(
	bundle.artifacts.flatMap((a) => a.fields ?? []).map((f) => [f.fieldId, f]),
);

let store: SqliteStore | undefined;
let dir = "";
afterEach(async () => {
	await store?.close();
	store = undefined;
	if (dir) rmSync(dir, { recursive: true, force: true });
});

async function setup() {
	dir = mkdtempSync(join(tmpdir(), "settings-adapter-"));
	store = openStore(join(dir, "db"), migrations);
	const settings = await createSettings(store, { dbPath: join(dir, "db") });
	const applied: Array<{ keys: unknown }> = [];
	const adapter = createSettingsAdapter(
		{
			inTransaction: settings.inTransaction,
			applyInTransaction: (db, input) => {
				applied.push({ keys: input.keys });
				return settings.applyInTransaction(db, input);
			},
			notifyChanged: settings.notifyChanged,
			diagnostics: settings.diagnostics,
		},
		{ fields: (_tx, id) => registered.get(id) },
	);
	return { store, settings, adapter, applied };
}
type Harness = Awaited<ReturnType<typeof setup>>;

function apply(
	h: Harness,
	input: unknown,
	options: { requestId?: string; origin?: "ui" | "conversation" } = {},
) {
	const requestId = options.requestId ?? crypto.randomUUID();
	return h.store.write((db) =>
		h.adapter.invokeInTransaction(db, {
			operationName: "settings.apply",
			input,
			requestId,
			issuedAt: new Date().toISOString(),
			origin:
				options.origin === "conversation"
					? {
							kind: "conversation",
							owner: {} as never,
							runId: "r",
							conversationId: "c",
							messageId: "m",
						}
					: { kind: "ui", scope: "scope", actionRequestId: requestId },
		}),
	);
}
const codeOf = async (promise: Promise<unknown>) => {
	try {
		await promise;
		return "no_error";
	} catch (error) {
		return (error as Error).message;
	}
};
const rev = (h: Harness) => h.settings.get().revision;

/** A saved document with a cloud connection and two TTS models. */
async function withModels(h: Harness) {
	const current = h.settings.get();
	const connectionId = crypto.randomUUID();
	const resources = [crypto.randomUUID(), crypto.randomUUID()];
	const next: Settings = structuredClone(current);
	next.connections.push({
		id: connectionId,
		name: "クラウド音声",
		baseUrl: "https://api.example.com/v1",
		enabled: true,
		epoch: 0,
		envRef: null,
	});
	for (const [i, id] of resources.entries())
		next.resources.push({
			id,
			connectionId,
			purpose: "tts",
			model: `tts-${i}`,
			contextWindow: null,
			voice: `voice-${i}`,
		});
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: current.revision,
		settings: next,
		keys: [{ connectionId, value: "sk-first" }],
	});
	return { connectionId, resources };
}

test("describe offers the settings document, one write operation, its queries and the Web conditions", () => {
	const d = describeSettingsAdapter();
	expect([...d.documents.keys()]).toEqual(["document:settings@1"]);
	expect(d.operations.get("settings.apply")).toEqual({
		inputSchemaRef: "schema:settings-apply@3",
		effect: "write",
	});
	expect([...d.queries].sort()).toEqual([
		"query:settings.asr-languages@1",
		"query:settings.asr-resources@1",
		"query:settings.connections@1",
		"query:settings.document@1",
		"query:settings.llm-resources@1",
		"query:settings.resources@1",
		"query:settings.routes@1",
		"query:settings.tts-resources@1",
	]);
	expect([...d.structures.keys()].sort()).toEqual([
		"structure:settings.add-connection@1",
		"structure:settings.add-connection@2",
		"structure:settings.add-resource@1",
		"structure:settings.add-resource@2",
		"structure:settings.confirm-larm-origin@1",
		"structure:settings.delete-connection@1",
		"structure:settings.delete-resource@1",
	]);
	expect([...d.conditions]).toEqual([...settingsConditions]);
	// The registered adapter is the one described for offline bundle checks.
	expect(offlineBundleHost().adapters.get("adapter:settings@1")).toBeDefined();
});

test("every field of the settings bundle names an existing, writable settings path and a declared condition", () => {
	const d = describeSettingsAdapter();
	const check = (path: string) =>
		d.documents.get("document:settings@1")!.describePath(path) !== null;
	expect(registered.size).toBeGreaterThan(25);
	for (const field of registered.values()) {
		expect(check(field.path)).toBe(true);
		if (field.visibleWhen)
			expect(d.conditions.has(field.visibleWhen)).toBe(true);
	}
});

test("describePath accepts leaves and stable-id array elements and rejects objects, managed values and unknown names", () => {
	const ok = (path: string) =>
		describeSettingsPath(path) !== null && settingsLeaf(path) !== null;
	for (const path of [
		"$.general.theme",
		"$.general.subtitles.size",
		"$.general.background",
		"$.larm.voice",
		"$.voice.silenceMs",
		"$.routes.llm.mode",
		"$.codingSupervision.approveInstructions",
		"$.resources[id=$target].voice",
		"$.resources[id=$target].speed",
		"$.connections[id=$target].name",
		"$.connections[id=$target].auth",
		"$.subagent.resourceId",
	])
		expect(ok(path)).toBe(true);
	for (const path of [
		"$",
		"$.general",
		"$.general.subtitles",
		"$.general.nothing",
		"$.revision",
		"$.routes.llm.epoch",
		"$.connections[id=$target].epoch",
		"$.resources[id=$target].id",
		"$.resources[id=$target]",
		"$.resources",
		"$.resources.voice",
		"$.connections",
		"$.general[id=$target].theme",
		"$.larm.voice[id=$target]",
		"general.theme",
		"$.general..theme",
		"$.general.theme[0]",
		"$.resources[0].voice",
		"$.resources[id=abc].voice",
	])
		expect(ok(path)).toBe(false);
});

test("a draft's changes become one saved revision with typed values, and the receipt carries no values", async () => {
	const h = await setup();
	let notified = 0;
	h.settings.onChange(() => notified++);
	const before = h.settings.get();
	const result = await apply(h, {
		expectedRevision: before.revision,
		changes: [
			{ fieldId: "conversation.agent-name", value: "セバスチャン" },
			{ fieldId: "conversation.persona", value: "sage" },
			{ fieldId: "appearance.theme", value: "dark" },
			{ fieldId: "appearance.subtitle-enabled", value: "true" },
			{ fieldId: "speech.volume", value: "0.5" },
			{ fieldId: "input.silence", value: "1200" },
		],
	});
	h.adapter.afterCommit!();
	const saved = h.settings.get();
	expect(saved.revision).toBe(before.revision + 1);
	expect(saved.general.agentName).toBe("セバスチャン");
	expect(saved.general.persona).toBe("sage");
	expect(saved.general.theme).toBe("dark");
	expect(saved.general.subtitles).toEqual({
		...before.general.subtitles,
		enabled: true,
	});
	expect(saved.voice.outputVolume).toBe(0.5);
	expect(saved.voice.silenceMs).toBe(1200);
	// Nothing else moved.
	expect({ ...saved, general: before.general, voice: before.voice }).toEqual({
		...before,
		revision: saved.revision,
	});
	expect(notified).toBe(1);
	expect(result.replay).toBe(false);
	expect(result.resultRefs).toEqual([
		expect.objectContaining({ owner: "settings", revision: saved.revision }),
	]);
	expect(JSON.stringify(result)).not.toContain("セバスチャン");
	expect(result.receiptRef.operationId).toBe(
		(result.receipt as { requestId: string }).requestId,
	);
});

test("an array element is chosen by its stable id and no other element changes", async () => {
	const h = await setup();
	const { resources } = await withModels(h);
	const before = h.settings.get();
	await apply(h, {
		expectedRevision: before.revision,
		changes: [
			{ fieldId: "resource.voice", target: resources[1], value: "nova" },
			{ fieldId: "resource.speed", target: resources[1], value: "1.5" },
		],
	});
	const saved = h.settings.get();
	const [first, second] = resources.map((id) =>
		saved.resources.find((r) => r.id === id)!,
	);
	expect(first!.voice).toBe("voice-0");
	expect(first!.speed).toBeUndefined();
	expect(second!.voice).toBe("nova");
	expect(second!.speed).toBe(1.5);
	// The order of the saved array does not matter: the same id still finds the same model.
	await h.store.write((db) => {
		const doc = JSON.parse(
			(
				db.query("SELECT document FROM settings_document").get() as {
					document: string;
				}
			).document,
		) as Settings;
		doc.resources.reverse();
		db.query("UPDATE settings_document SET document=?").run(
			JSON.stringify(doc),
		);
	});
	await apply(h, {
		expectedRevision: rev(h),
		changes: [
			{ fieldId: "resource.voice", target: resources[0], value: "echo" },
		],
	});
	expect(
		h.settings.get().resources.find((r) => r.id === resources[0])!.voice,
	).toBe("echo");
	expect(
		h.settings.get().resources.find((r) => r.id === resources[1])!.voice,
	).toBe("nova");
});

test("targets are required for element fields, refused for plain fields and must exist", async () => {
	const h = await setup();
	const { resources } = await withModels(h);
	const expectedRevision = rev(h);
	const code = (change: Record<string, unknown>) =>
		codeOf(apply(h, { expectedRevision, changes: [change] }));
	expect(await code({ fieldId: "resource.voice", value: "x" })).toBe(
		"target_invalid",
	);
	expect(
		await code({
			fieldId: "appearance.theme",
			target: resources[0],
			value: "dark",
		}),
	).toBe("target_invalid");
	expect(
		await code({
			fieldId: "resource.voice",
			target: crypto.randomUUID(),
			value: "x",
		}),
	).toBe("target_not_found");
	expect(rev(h)).toBe(expectedRevision);
});

test("unset follows the field's registered meaning and is refused elsewhere", async () => {
	const h = await setup();
	await apply(h, {
		expectedRevision: rev(h),
		changes: [
			{ fieldId: "appearance.background", value: "spatial" },
			{ fieldId: "larm.speech-style", value: "calm" },
		],
	});
	expect(h.settings.get().general.background).toBe("spatial");
	expect(h.settings.get().larm.style).toBe("calm");
	await apply(h, {
		expectedRevision: rev(h),
		changes: [
			{ fieldId: "appearance.background", unset: true },
			{ fieldId: "larm.speech-style", unset: true },
		],
	});
	expect(Object.hasOwn(h.settings.get().general, "background")).toBe(false);
	expect(Object.hasOwn(h.settings.get().larm, "style")).toBe(false);
	// A required field has no unset meaning.
	expect(
		await codeOf(
			apply(h, {
				expectedRevision: rev(h),
				changes: [{ fieldId: "appearance.theme", unset: true }],
			}),
		),
	).toBe("unset_not_allowed");
});

test("rejections are safe codes and save nothing", async () => {
	const h = await setup();
	const expectedRevision = rev(h);
	const code = (changes: Array<Record<string, unknown>>, input = {}) =>
		codeOf(apply(h, { expectedRevision, changes, ...input }));
	expect(await code([{ fieldId: "no.such-field", value: "x" }])).toBe(
		"field_not_registered",
	);
	expect(
		await code([{ fieldId: "conversation.persona", value: "pirate" }]),
	).toBe("invalid_settings");
	expect(await code([{ fieldId: "speech.volume", value: "2" }])).toBe(
		"invalid_settings",
	);
	expect(await code([{ fieldId: "speech.volume", value: "abc" }])).toBe(
		"invalid_value",
	);
	expect(await code([{ fieldId: "speech.enabled", value: "yes" }])).toBe(
		"invalid_value",
	);
	expect(
		await code([
			{ fieldId: "appearance.theme", value: "dark" },
			{ fieldId: "appearance.theme", value: "light" },
		]),
	).toBe("duplicate_change");
	expect(await code([{ fieldId: "appearance.theme" }])).toBe("invalid_input");
	expect(
		await code([{ fieldId: "appearance.theme", value: "dark", extra: 1 }]),
	).toBe("invalid_input");
	expect(await code([])).toBe("invalid_input");
	expect(rev(h)).toBe(expectedRevision);
});

test("conversations cannot change settings", async () => {
	const h = await setup();
	expect(
		await codeOf(
			apply(
				h,
				{
					expectedRevision: rev(h),
					changes: [{ fieldId: "appearance.theme", value: "dark" }],
				},
				{ origin: "conversation" },
			),
		),
	).toBe("capability_unavailable");
});

test("a stale draft is reported as revision_conflict, even when its target has since gone", async () => {
	const h = await setup();
	const { resources } = await withModels(h);
	const stale = rev(h);
	await apply(h, {
		expectedRevision: stale,
		changes: [{ fieldId: "appearance.theme", value: "light" }],
	});
	expect(
		await codeOf(
			apply(h, {
				expectedRevision: stale,
				changes: [{ fieldId: "appearance.theme", value: "dark" }],
			}),
		),
	).toBe("revision_conflict");
	expect(
		await codeOf(
			apply(h, {
				expectedRevision: stale,
				changes: [
					{
						fieldId: "resource.voice",
						target: crypto.randomUUID(),
						value: "x",
					},
				],
			}),
		),
	).toBe("revision_conflict");
	expect(h.settings.get().general.theme).toBe("light");
	expect(resources).toHaveLength(2);
});

test("the same request id is a replay and saves once", async () => {
	const h = await setup();
	const requestId = crypto.randomUUID();
	const input = {
		expectedRevision: rev(h),
		changes: [{ fieldId: "conversation.user-name", value: "主" }],
	};
	const first = await apply(h, input, { requestId });
	const revision = rev(h);
	const again = await apply(h, input, { requestId });
	expect(first.replay).toBe(false);
	expect(again.replay).toBe(true);
	expect(rev(h)).toBe(revision);
	expect(again.receiptRef.digest).toBe(first.receiptRef.digest);
});

test("keys go through to the settings domain and never into the result or an error", async () => {
	const h = await setup();
	const { connectionId } = await withModels(h);
	const secret = "sk-super-secret-token";
	const result = await apply(h, {
		expectedRevision: rev(h),
		changes: [{ fieldId: "appearance.theme", value: "dark" }],
		keys: [{ connectionId, value: secret }],
	});
	expect(h.applied.at(-1)!.keys).toEqual([{ connectionId, value: secret }]);
	expect(JSON.stringify(result)).not.toContain(secret);
	expect((result.receipt as { keys: number }).keys).toBe(1);
	expect(
		h.settings.diagnostics().connections.find((c) => c.id === connectionId)
			?.credentialAvailable,
	).toBe(true);
	// A delete is an explicit null; a key for an unknown connection fails without echoing it.
	await apply(h, {
		expectedRevision: rev(h),
		changes: [{ fieldId: "appearance.theme", value: "light" }],
		keys: [{ connectionId, delete: true }],
	});
	expect(h.applied.at(-1)!.keys).toEqual([{ connectionId, value: null }]);
	expect(
		h.settings.diagnostics().connections.find((c) => c.id === connectionId)
			?.credentialAvailable,
	).toBe(false);
	const failure = await codeOf(
		apply(h, {
			expectedRevision: rev(h),
			changes: [{ fieldId: "appearance.theme", value: "dark" }],
			keys: [{ connectionId: crypto.randomUUID(), value: secret }],
		}),
	);
	expect(failure).toBe("invalid_key_connection");
	expect(failure).not.toContain(secret);
	expect(
		await codeOf(
			apply(h, {
				expectedRevision: rev(h),
				changes: [{ fieldId: "appearance.theme", value: "dark" }],
				keys: [{ connectionId, value: secret, delete: true }],
			}),
		),
	).toBe("invalid_input");
});

test("sources give the saved document, the TTS models as targets and the ASR languages", async () => {
	const h = await setup();
	const { resources } = await withModels(h);
	const read = (query: string) =>
		h.store.read((db) => h.adapter.sourceInTransaction(db, query, undefined));
	const document = read("query:settings.document@1")!;
	expect(document.revision).toBe(rev(h));
	expect((document.data as { settings: Settings }).settings).toEqual(
		h.settings.get(),
	);
	// Assign the first model to speech and read the targets again.
	const current = h.settings.get();
	const next = structuredClone(current);
	next.routes.tts.fallbackId = resources[0]!;
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: current.revision,
		settings: next,
		keys: [],
	});
	const targets = read("query:settings.tts-resources@1")!.data as {
		localAvailable: boolean;
		targets: Array<{ id: string; label: string; assigned: boolean }>;
	};
	expect(targets.localAvailable).toBe(true);
	expect(targets.targets.map((t) => [t.id, t.label, t.assigned])).toEqual([
		[resources[0]!, "クラウド音声 / tts-0", true],
		[resources[1]!, "クラウド音声 / tts-1", false],
	]);
	expect(read("query:settings.unknown@1")).toBeNull();
});

test("fields registered by published artifacts are found through capabilities", async () => {
	const h = await setup();
	const capabilities = createCapabilities(
		h.store,
		new Set(["web", "history", "timer"]),
		{ bundleHost: offlineBundleHost },
	);
	await capabilities.seed();
	const lookup = publishedSettingsFields(() => capabilities);
	const found = h.store.read((db) => lookup(db, "appearance.theme"));
	expect(found).toMatchObject({
		document: "document:settings@1",
		path: "$.general.theme",
	});
	expect(h.store.read((db) => lookup(db, "no.such-field"))).toBeUndefined();
	// Every launcher artifact of the bundle is published, so every field is reachable.
	for (const id of registered.keys())
		expect(h.store.read((db) => lookup(db, id))?.fieldId).toBe(id);
});

test("the registered settings bundle applies a draft through the action ledger and rejects a stale one", async () => {
	const h = await setup();
	const capabilities = createCapabilities(
		h.store,
		new Set(["web", "history", "timer"]),
		{ bundleHost: offlineBundleHost },
	);
	await capabilities.seed();
	const registry = createAdapterRegistry([
		createSettingsAdapter(h.settings, {
			fields: publishedSettingsFields(() => capabilities),
		}),
	]);
	const ledger = createActionRequests({
		store: h.store,
		capabilities,
		registry,
		scope: "test-scope",
		secretKey: () => h.settings.derivedKey("test"),
	});
	const send = (
		revision: number,
		changes: unknown[],
		source = "settings-conversation",
	) => {
		const now = Date.now();
		return ledger.submit({
			version: 1,
			eventId: crypto.randomUUID(),
			eventCreatedAt: new Date(now).toISOString(),
			eventExpiresAt: new Date(now + 60_000).toISOString(),
			artifactId: "tab-1",
			artifactRevisionId: "artifact:settings.conversation@7",
			source,
			sourceRevision: revision,
			actionId: "apply",
			scopeRef: ledger.scopeRef,
			input: { expectedRevision: revision, changes },
		});
	};
	const revision = rev(h);
	const accepted = await send(revision, [
		{ fieldId: "conversation.agent-name", value: "アルフレッド" },
		{ fieldId: "conversation.persona", value: "maid" },
	]);
	expect(accepted.request.status).toBe("accepted");
	expect(accepted.request.result?.resultRefs[0]?.revision).toBe(revision + 1);
	expect(h.settings.get().general).toMatchObject({
		agentName: "アルフレッド",
		persona: "maid",
	});
	// The same draft against the old revision is a conflict the screen can show.
	const stale = await send(revision, [
		{ fieldId: "conversation.persona", value: "sage" },
	]);
	expect(stale.request.status).toBe("rejected");
	expect(stale.request.errorCode).toBe("revision_conflict");
	expect(h.settings.get().general.persona).toBe("maid");
	// A value the schema refuses is a rejection with a safe code and saves nothing.
	const invalid = await send(rev(h), [
		{ fieldId: "conversation.persona", value: "pirate" },
	]);
	expect(invalid.request.errorCode).toBe("invalid_settings");
	expect(rev(h)).toBe(revision + 1);
});

test("describePath reports kind, bounds, enum values and optional/nullable from the settings schema", () => {
	const info = (path: string) => describeSettingsPath(path)!;
	expect(info("$.general.theme")).toEqual({
		kind: "enum",
		values: ["system", "light", "dark"],
		optional: false,
		nullable: false,
	});
	expect(info("$.general.background")).toMatchObject({
		kind: "enum",
		optional: true,
		nullable: false,
	});
	expect(info("$.voice.outputVolume")).toMatchObject({
		kind: "number",
		min: 0,
		max: 1,
	});
	expect(info("$.voice.silenceMs")).toMatchObject({
		kind: "integer",
		min: 300,
		max: 3000,
	});
	expect(info("$.larm.pitchScale")).toMatchObject({
		kind: "number",
		min: -0.15,
		max: 0.15,
		optional: true,
	});
	expect(info("$.general.agentName")).toMatchObject({
		kind: "string",
		maxLength: 40,
	});
	expect(info("$.voice.autoSpeak").kind).toBe("boolean");
	expect(info("$.resources[id=$target].voice")).toMatchObject({
		kind: "string",
		maxLength: 200,
		nullable: true,
	});
	expect(info("$.resources[id=$target].speed")).toMatchObject({
		kind: "number",
		min: 0.5,
		max: 2,
		optional: true,
	});
	const d = describeSettingsAdapter().documents.get("document:settings@1")!;
	expect(d.targetQuery!("$.resources[id=$target].voice")).toBe(
		"query:settings.tts-resources@1",
	);
	expect(d.targetQuery!("$.general.theme")).toBeNull();
});

test("a target must be one the field's query lists: another purpose's model is refused", async () => {
	const h = await setup();
	const { connectionId } = await withModels(h);
	const current = h.settings.get();
	const next = structuredClone(current);
	const llm = crypto.randomUUID();
	next.resources.push({
		id: llm,
		connectionId,
		purpose: "llm",
		model: "chat",
		contextWindow: 8192,
		voice: null,
	});
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: current.revision,
		settings: next,
		keys: [],
	});
	expect(
		await codeOf(
			apply(h, {
				expectedRevision: rev(h),
				changes: [{ fieldId: "resource.voice", target: llm, value: "x" }],
			}),
		),
	).toBe("target_not_found");
});

// ---- structures (P2) -------------------------------------------------------------------------

const ADD_CONNECTION = "structure:settings.add-connection@1";
const DELETE_CONNECTION = "structure:settings.delete-connection@1";
const ADD_RESOURCE = "structure:settings.add-resource@1";
const DELETE_RESOURCE = "structure:settings.delete-resource@1";
const CONFIRM_ORIGIN = "structure:settings.confirm-larm-origin@1";
const uuid = () => crypto.randomUUID();
const connectionInput = (id: string, extra: Record<string, unknown> = {}) => ({
	connectionId: id,
	name: "クラウド",
	baseUrl: "https://api.example.com/v1",
	...extra,
});
const structure = (structureRef: string, input: Record<string, unknown>) => ({
	structure: structureRef,
	input,
});

test("every structure and action of the bundle is registered with a matching schema", () => {
	const d = describeSettingsAdapter();
	const schemas = new Map(
		(
			bundle as unknown as {
				schemas: Array<{ id: string; revision: number }>;
			}
		).schemas.map((x) => [`schema:${x.id}@${x.revision}`, x]),
	);
	for (const [ref, { inputSchemaRef }] of d.structures)
		expect([ref, schemas.has(inputSchemaRef)]).toEqual([ref, true]);
	const ai = (
		bundle as unknown as {
			artifacts: Array<{
				id: string;
				actionBindings: Array<{ structure?: string; inputSchemaRef: string }>;
			}>;
		}
	).artifacts.filter((a) => a.id === "settings.ai-connections");
	const staged = ai.flatMap((a) => a.actionBindings.filter((a) => a.structure));
	expect([...new Set(staged.map((a) => a.structure))].sort()).toEqual(
		[...d.structures.keys()].sort(),
	);
	for (const action of staged)
		expect(action.inputSchemaRef).toBe(
			d.structures.get(action.structure!)!.inputSchemaRef,
		);
});

test("a connection is added with its first model, its key and the route it fills", async () => {
	const h = await setup();
	const connectionId = uuid();
	const resourceId = uuid();
	const result = await apply(h, {
		expectedRevision: rev(h),
		structural: [
			structure(
				ADD_CONNECTION,
				connectionInput(connectionId, {
					purpose: "llm",
					model: "gpt-x",
					resourceId,
					assign: true,
				}),
			),
		],
		keys: [{ connectionId, value: "sk-new-key" }],
	});
	const saved = h.settings.get();
	expect(saved.connections).toEqual([
		expect.objectContaining({
			id: connectionId,
			name: "クラウド",
			enabled: true,
			epoch: 1,
			envRef: null,
		}),
	]);
	expect(saved.connections[0]!.kind).toBeUndefined();
	expect(saved.resources).toEqual([
		expect.objectContaining({
			id: resourceId,
			connectionId,
			purpose: "llm",
			model: "gpt-x",
			contextWindow: 8192,
			voice: null,
		}),
	]);
	expect(saved.routes.llm.fallbackId).toBe(resourceId);
	expect(
		h.settings.diagnostics().connections.find((c) => c.id === connectionId)
			?.credentialAvailable,
	).toBe(true);
	expect(JSON.stringify(result)).not.toContain("sk-new-key");
	expect((result.receipt as { structural: string[] }).structural).toEqual([
		ADD_CONNECTION,
	]);
	// A purpose that already has a fallback keeps it.
	const second = uuid();
	await apply(h, {
		expectedRevision: rev(h),
		structural: [
			structure(ADD_RESOURCE, {
				resourceId: second,
				connectionId,
				purpose: "llm",
				model: "gpt-y",
				assign: true,
			}),
		],
	});
	expect(h.settings.get().routes.llm.fallbackId).toBe(resourceId);
	expect(h.settings.get().resources).toHaveLength(2);
});

test("a new connection takes exactly one credential source, except CLI-login agent kinds", async () => {
	const h = await setup();
	const code = (
		input: Record<string, unknown>,
		keys?: Array<Record<string, unknown>>,
	) =>
		codeOf(
			apply(h, {
				expectedRevision: rev(h),
				structural: [structure(ADD_CONNECTION, input)],
				...(keys ? { keys } : {}),
			}),
		);
	const a = uuid();
	expect(await code(connectionInput(a))).toBe("credential_required");
	expect(
		await code(connectionInput(a, { envRef: "EUMENES_CLOUD_KEY" }), [
			{ connectionId: a, value: "sk-both" },
		]),
	).toBe("invalid_credential_source");
	// An environment variable alone is a source; so is a key alone.
	expect(await code(connectionInput(a, { envRef: "EUMENES_CLOUD_KEY" }))).toBe(
		"no_error",
	);
	const b = uuid();
	expect(
		await code(connectionInput(b), [{ connectionId: b, value: "sk-b" }]),
	).toBe("no_error");
	// Codex may use the CLI login; Claude Agent SDK needs its auth method and a stored credential.
	const c = uuid();
	expect(
		await code(
			connectionInput(c, {
				kind: "codex-sdk",
				purpose: "llm",
				model: "codex",
				resourceId: uuid(),
			}),
		),
	).toBe("no_error");
	const m = uuid();
	expect(await code(connectionInput(m, { kind: "claude-agent-sdk" }))).toBe(
		"auth_required",
	);
	expect(
		await code(
			connectionInput(m, { kind: "claude-agent-sdk", auth: "subscription" }),
		),
	).toBe("credential_required");
	expect(
		await code(
			connectionInput(m, {
				kind: "claude-agent-sdk",
				auth: "api-key",
			}),
		),
	).toBe("credential_required");
	// A subscription takes the setup token as a stored key, never an environment variable.
	expect(
		await code(
			connectionInput(m, {
				kind: "claude-agent-sdk",
				auth: "subscription",
				envRef: "EUMENES_CLOUD_KEY",
			}),
		),
	).toBe("invalid_credential_source");
	expect(
		await code(
			connectionInput(m, { kind: "claude-agent-sdk", auth: "subscription" }),
			[{ connectionId: m, value: "setup-token" }],
		),
	).toBe("no_error");
	const k = uuid();
	expect(
		await code(
			connectionInput(k, {
				kind: "claude-agent-sdk",
				auth: "api-key",
				envRef: "EUMENES_CLOUD_KEY",
			}),
		),
	).toBe("no_error");
	// The removed Managed Agents kind and its fields are no longer input.
	expect(
		await code(connectionInput(uuid(), { kind: "claude-managed-agents" }), []),
	).toBe("invalid_input");
	expect(await code(connectionInput(uuid(), { agentId: "agent_1" }), [])).toBe(
		"invalid_input",
	);
	// A repeated id, a half-given model and unknown input are refused.
	expect(await code(connectionInput(a, { envRef: "EUMENES_CLOUD_KEY" }))).toBe(
		"connection_exists",
	);
	expect(await code(connectionInput(uuid(), { model: "x" }))).toBe(
		"invalid_input",
	);
	expect(await code({ ...connectionInput(uuid()), extra: 1 })).toBe(
		"invalid_input",
	);
	expect(
		h.settings
			.get()
			.connections.map((x) => `${x.kind ?? "http"}:${x.auth ?? "-"}`),
	).toEqual([
		"http:-",
		"http:-",
		"codex-sdk:-",
		"claude-agent-sdk:subscription",
		"claude-agent-sdk:api-key",
	]);
});

test("deleting a connection removes its models, frees the routes that used them and drops its key", async () => {
	const h = await setup();
	const { connectionId, resources } = await withModels(h);
	// Route speech to the first model, cloud-only.
	const current = h.settings.get();
	const next = structuredClone(current);
	next.routes.tts = {
		...next.routes.tts,
		mode: "cloud-only",
		cloudAllowed: true,
		fallbackId: resources[0]!,
	};
	await h.settings.apply({
		requestId: uuid(),
		expectedRevision: current.revision,
		settings: next,
		keys: [],
	});
	const other = uuid();
	await apply(h, {
		expectedRevision: rev(h),
		structural: [
			structure(
				ADD_CONNECTION,
				connectionInput(other, { envRef: "EUMENES_CLOUD_K" }),
			),
			structure(DELETE_CONNECTION, { connectionId }),
		],
		// The key of the deleted connection is dropped, not an error.
		keys: [{ connectionId, value: "sk-late" }],
	});
	const saved = h.settings.get();
	expect(saved.connections.map((c) => c.id)).toEqual([other]);
	expect(saved.resources).toEqual([]);
	expect(saved.routes.tts.fallbackId).toBeNull();
	expect(saved.routes.tts.mode).toBe("larm-preferred");
	expect(h.settings.diagnostics().connections.map((c) => c.id)).toEqual([
		other,
	]);
	expect(
		await codeOf(
			apply(h, {
				expectedRevision: rev(h),
				structural: [structure(DELETE_CONNECTION, { connectionId })],
			}),
		),
	).toBe("target_not_found");
});

test("connection targets name the auth method and never claim a Claude login", async () => {
	const h = await setup();
	const [subscription, apiKey, codex] = [uuid(), uuid(), uuid()];
	await apply(h, {
		expectedRevision: rev(h),
		structural: [
			structure(
				ADD_CONNECTION,
				connectionInput(subscription, {
					kind: "claude-agent-sdk",
					auth: "subscription",
				}),
			),
			structure(
				ADD_CONNECTION,
				connectionInput(apiKey, {
					kind: "claude-agent-sdk",
					auth: "api-key",
					envRef: "EUMENES_CLOUD_KEY",
				}),
			),
			structure(ADD_CONNECTION, connectionInput(codex, { kind: "codex-sdk" })),
		],
		keys: [{ connectionId: subscription, value: "setup-token" }],
	});
	const targets = (
		h.store.read((db) =>
			h.adapter.sourceInTransaction(
				db,
				"query:settings.connections@1",
				undefined,
			),
		)!.data as { targets: Array<Record<string, unknown>> }
	).targets;
	expect(targets.map((t) => [t.kind, t.auth, t.credential])).toEqual([
		["claude-agent-sdk", "subscription", "registered"],
		["claude-agent-sdk", "api-key", "environment"],
		["codex-sdk", undefined, "login"],
	]);
	expect(JSON.stringify(targets)).not.toContain("setup-token");
});

test("deleting a model or connection also frees the dedicated World and sub-agent models that used it", async () => {
	const h = await setup();
	const { connectionId } = await withModels(h);
	const worldModel = uuid();
	const subagentModel = uuid();
	await apply(h, {
		expectedRevision: rev(h),
		structural: [
			structure(ADD_RESOURCE, {
				resourceId: worldModel,
				connectionId,
				purpose: "llm",
				model: "world-model",
			}),
			structure(ADD_RESOURCE, {
				resourceId: subagentModel,
				connectionId,
				purpose: "llm",
				model: "subagent-model",
			}),
		],
	});
	const current = h.settings.get();
	current.world.curationResourceId = worldModel;
	current.subagent.resourceId = subagentModel;
	await h.settings.apply({
		requestId: uuid(),
		expectedRevision: current.revision,
		settings: current,
		keys: [],
	});
	await apply(h, {
		expectedRevision: rev(h),
		structural: [structure(DELETE_RESOURCE, { resourceId: subagentModel })],
	});
	expect(h.settings.get().subagent.resourceId).toBeNull();
	expect(h.settings.get().world.curationResourceId).toBe(worldModel);
	await apply(h, {
		expectedRevision: rev(h),
		structural: [structure(DELETE_CONNECTION, { connectionId })],
	});
	expect(h.settings.get().world.curationResourceId).toBeNull();
	expect(h.settings.get().resources).toEqual([]);
});

test("models are added and deleted, and a change may name an added model as its target", async () => {
	const h = await setup();
	const { connectionId, resources } = await withModels(h);
	const added = uuid();
	await apply(h, {
		expectedRevision: rev(h),
		structural: [
			structure(ADD_RESOURCE, {
				resourceId: added,
				connectionId,
				purpose: "llm",
				model: "",
			}),
		],
		changes: [],
	}).catch(() => undefined);
	// The model name is required; an empty one is refused as input and nothing is added.
	expect(h.settings.get().resources).toHaveLength(2);
	await apply(h, {
		expectedRevision: rev(h),
		structural: [
			structure(ADD_RESOURCE, {
				resourceId: added,
				connectionId,
				purpose: "llm",
				model: "tmp",
			}),
		],
		changes: [{ fieldId: "resource.model", target: added, value: "gpt-final" }],
	});
	expect(h.settings.get().resources.find((r) => r.id === added)).toMatchObject({
		model: "gpt-final",
		contextWindow: 8192,
	});
	await apply(h, {
		expectedRevision: rev(h),
		structural: [structure(DELETE_RESOURCE, { resourceId: resources[0]! })],
	});
	expect(h.settings.get().resources.map((r) => r.id)).toEqual([
		resources[1]!,
		added,
	]);
	expect(
		await codeOf(
			apply(h, {
				expectedRevision: rev(h),
				structural: [structure(DELETE_RESOURCE, { resourceId: resources[0]! })],
			}),
		),
	).toBe("target_not_found");
	expect(
		await codeOf(
			apply(h, {
				expectedRevision: rev(h),
				structural: [
					structure(ADD_RESOURCE, {
						resourceId: uuid(),
						connectionId: uuid(),
						purpose: "llm",
						model: "x",
					}),
				],
			}),
		),
	).toBe("target_not_found");
	expect(
		await codeOf(
			apply(h, {
				expectedRevision: rev(h),
				structural: [{ structure: "structure:settings.nothing@1", input: {} }],
			}),
		),
	).toBe("structure_not_registered");
	expect(await codeOf(apply(h, { expectedRevision: rev(h) }))).toBe(
		"invalid_input",
	);
});

test("changing a model's purpose resets the purpose's values and frees its route", async () => {
	const h = await setup();
	const { resources } = await withModels(h);
	const current = h.settings.get();
	const next = structuredClone(current);
	next.routes.tts.fallbackId = resources[0]!;
	next.routes.tts.mode = "cloud-only";
	await h.settings.apply({
		requestId: uuid(),
		expectedRevision: current.revision,
		settings: next,
		keys: [],
	});
	// The context length given in the same draft wins over the reset, whatever the order.
	await apply(h, {
		expectedRevision: rev(h),
		changes: [
			{ fieldId: "resource.context", target: resources[0], value: "16384" },
			{ fieldId: "resource.purpose", target: resources[0], value: "llm" },
		],
	});
	const saved = h.settings.get();
	expect(saved.resources.find((r) => r.id === resources[0])).toMatchObject({
		purpose: "llm",
		contextWindow: 16384,
		voice: null,
	});
	expect(saved.routes.tts.fallbackId).toBeNull();
	expect(saved.routes.tts.mode).toBe("larm-preferred");
});

test("turning cloud sending off leaves a cloud-only purpose LARM only", async () => {
	const h = await setup();
	const { resources } = await withModels(h);
	const current = h.settings.get();
	const next = structuredClone(current);
	next.routes.tts = {
		...next.routes.tts,
		mode: "cloud-only",
		cloudAllowed: true,
		fallbackId: resources[0]!,
	};
	await h.settings.apply({
		requestId: uuid(),
		expectedRevision: current.revision,
		settings: next,
		keys: [],
	});
	await apply(h, {
		expectedRevision: rev(h),
		changes: [{ fieldId: "route.tts.cloud-allowed", value: "false" }],
	});
	expect(h.settings.get().routes.tts).toMatchObject({
		mode: "larm-only",
		cloudAllowed: false,
		fallbackId: resources[0],
	});
	// The rule is not a rewrite of an explicit request: cloud-only without permission stays invalid.
	expect(
		await codeOf(
			apply(h, {
				expectedRevision: rev(h),
				changes: [{ fieldId: "route.tts.mode", value: "cloud-only" }],
			}),
		),
	).toBe("invalid_settings");
	// A fallback is chosen and cleared through its field (unset is null).
	await apply(h, {
		expectedRevision: rev(h),
		changes: [{ fieldId: "route.tts.fallback", unset: true }],
	});
	expect(h.settings.get().routes.tts.fallbackId).toBeNull();
});

test("a changed LARM origin needs its confirmation as a structure", async () => {
	const h = await setup();
	await apply(h, {
		expectedRevision: rev(h),
		changes: [{ fieldId: "larm.url", value: "http://127.0.0.1:8080" }],
	});
	const change = { fieldId: "larm.url", value: "http://127.0.0.1:9090" };
	expect(
		await codeOf(apply(h, { expectedRevision: rev(h), changes: [change] })),
	).toBe("invalid_larm_origin_unconfirmed");
	expect(
		await codeOf(
			apply(h, {
				expectedRevision: rev(h),
				structural: [
					structure(CONFIRM_ORIGIN, { origin: "http://127.0.0.1:7777" }),
				],
				changes: [change],
			}),
		),
	).toBe("invalid_larm_origin_unconfirmed");
	await apply(h, {
		expectedRevision: rev(h),
		structural: [
			structure(CONFIRM_ORIGIN, { origin: "http://127.0.0.1:9090" }),
		],
		changes: [change],
	});
	expect(h.settings.get().larm.baseUrl).toBe("http://127.0.0.1:9090");
	// Clearing the URL is the field's null.
	await apply(h, {
		expectedRevision: rev(h),
		changes: [{ fieldId: "larm.url", unset: true }],
	});
	expect(h.settings.get().larm.baseUrl).toBeNull();
});

test("connection fields use the connection query's targets, and the API key never travels in changes", async () => {
	const h = await setup();
	const { connectionId, resources } = await withModels(h);
	await apply(h, {
		expectedRevision: rev(h),
		changes: [
			{ fieldId: "connection.name", target: connectionId, value: "改名" },
			{ fieldId: "connection.enabled", target: connectionId, value: "false" },
		],
	});
	expect(h.settings.get().connections[0]).toMatchObject({
		name: "改名",
		enabled: false,
	});
	// A model id is not a connection target, and a connection is not a model target.
	expect(
		await codeOf(
			apply(h, {
				expectedRevision: rev(h),
				changes: [
					{ fieldId: "connection.name", target: resources[0], value: "x" },
				],
			}),
		),
	).toBe("target_not_found");
	expect(
		await codeOf(
			apply(h, {
				expectedRevision: rev(h),
				changes: [
					{ fieldId: "resource.model", target: connectionId, value: "x" },
				],
			}),
		),
	).toBe("target_not_found");
	// The key field is a confidential channel: its values go in `keys`.
	const keyField = registered.get("connection.api-key")!;
	expect(keyField.path).toBe("$.connections[id=$target].apiKey");
	expect(
		await codeOf(
			apply(h, {
				expectedRevision: rev(h),
				changes: [
					{
						fieldId: "connection.api-key",
						target: connectionId,
						value: "sk-x",
					},
				],
			}),
		),
	).toBe("field_not_registered");
	const d = describeSettingsAdapter().documents.get("document:settings@1")!;
	expect(d.describePath(keyField.path)).toMatchObject({
		kind: "string",
		maxLength: 4096,
		optional: true,
		nullable: true,
	});
	expect(d.targetQuery!(keyField.path)).toBe("query:settings.connections@1");
	expect(d.targetQuery!("$.resources[id=$target].model")).toBe(
		"query:settings.resources@1",
	);
});

test("sources list connections without credentials, models per purpose and the routes", async () => {
	const h = await setup();
	const { connectionId, resources } = await withModels(h);
	const read = (query: string) =>
		h.store.read((db) => h.adapter.sourceInTransaction(db, query, undefined))!
			.data as Record<string, any>;
	const connections = read("query:settings.connections@1");
	expect(connections.targets).toEqual([
		{
			id: connectionId,
			label: "クラウド音声",
			kind: "openai-compatible",
			enabled: true,
			credential: "registered",
		},
	]);
	expect(JSON.stringify(connections)).not.toContain("sk-first");
	expect(read("query:settings.llm-resources@1").targets).toEqual([]);
	expect(
		read("query:settings.tts-resources@1").options.map(
			(o: { value: string }) => o.value,
		),
	).toEqual(resources);
	const all = read("query:settings.resources@1").targets;
	expect(all.map((t: { purpose: string }) => t.purpose)).toEqual([
		"tts",
		"tts",
	]);
	expect(all[0]).toMatchObject({
		label: "クラウド音声 / tts-0",
		connectionId,
		model: "tts-0",
	});
	const routes = read("query:settings.routes@1").routes;
	expect(routes.tts).toMatchObject({
		mode: "larm-preferred",
		fallbackId: null,
		fallbackLabel: null,
		resourceCount: 2,
	});
	expect(routes.llm.resourceCount).toBe(0);
});

test("the AI and external-work artifacts apply through the action ledger with structure and keys", async () => {
	const h = await setup();
	const capabilities = createCapabilities(
		h.store,
		new Set(["web", "history", "timer"]),
		{
			bundleHost: offlineBundleHost,
		},
	);
	await capabilities.seed();
	const ledger = createActionRequests({
		store: h.store,
		capabilities,
		registry: createAdapterRegistry([
			createSettingsAdapter(h.settings, {
				fields: publishedSettingsFields(() => capabilities),
			}),
			// The screen's probe sources name the inference adapter too.
			createInferenceAdapter(
				{
					probes: () => [],
					getProbe: () => null,
					inspect: () => ({}),
					usage: () => [],
					startProbeInTransaction: () => ({ id: "x", launch() {} }),
					cancelProbeInTransaction() {},
					cancelProbe() {},
				},
				h.settings,
			),
		]),
		scope: "test-scope",
		secretKey: () => h.settings.derivedKey("test"),
	});
	const connectionId = uuid();
	const send = (input: unknown) => {
		const now = Date.now();
		return ledger.submit({
			version: 1,
			eventId: uuid(),
			eventCreatedAt: new Date(now).toISOString(),
			eventExpiresAt: new Date(now + 60_000).toISOString(),
			artifactId: "tab-ai",
			artifactRevisionId: "artifact:settings.ai-connections@8",
			source: "settings-ai",
			sourceRevision: rev(h),
			actionId: "apply",
			scopeRef: ledger.scopeRef,
			input,
		});
	};
	const accepted = await send({
		expectedRevision: rev(h),
		structural: [structure(ADD_CONNECTION, connectionInput(connectionId))],
		changes: [{ fieldId: "route.llm.cloud-allowed", value: "false" }],
		keys: [{ connectionId, value: "sk-ledger" }],
	});
	expect(accepted.request.status).toBe("accepted");
	expect(h.settings.get().connections.map((c) => c.id)).toEqual([connectionId]);
	expect(h.settings.get().routes.llm.cloudAllowed).toBe(false);
	// The secret is neither in the stored result nor in the ledger row's input.
	expect(JSON.stringify(accepted)).not.toContain("sk-ledger");
	const row = h.store.read((db) =>
		db.query("SELECT canonical_input_json FROM tool_action_requests").all(),
	);
	expect(JSON.stringify(row)).not.toContain("sk-ledger");
});

test("a key alone is an apply, and a key inside a structure's input is refused", async () => {
	const h = await setup();
	const { connectionId } = await withModels(h);
	const before = rev(h);
	await apply(h, {
		expectedRevision: before,
		keys: [{ connectionId, value: "sk-only-key" }],
	});
	expect(rev(h)).toBe(before + 1);
	expect(
		h.settings.diagnostics().connections.find((c) => c.id === connectionId)
			?.credentialAvailable,
	).toBe(true);
	await apply(h, {
		expectedRevision: rev(h),
		keys: [{ connectionId, delete: true }],
	});
	expect(
		h.settings.diagnostics().connections.find((c) => c.id === connectionId)
			?.credentialAvailable,
	).toBe(false);
	// Nothing at all is still nothing to apply.
	expect(await codeOf(apply(h, { expectedRevision: rev(h), keys: [] }))).toBe(
		"invalid_input",
	);
	// The create form's key is moved to `keys` by the host: in the input it fails closed.
	const added = crypto.randomUUID();
	const code = await codeOf(
		apply(h, {
			expectedRevision: rev(h),
			structural: [
				{
					structure: "structure:settings.add-connection@1",
					input: {
						connectionId: added,
						name: "x",
						baseUrl: "https://api.example.com/v1",
						apiKey: "sk-in-input",
					},
				},
			],
		}),
	);
	expect(code).toBe("invalid_input");
	expect(code).not.toContain("sk-in-input");
});

test("the AI screen's collections name registered actions with rows built by fixed paths", () => {
	const ai = (
		bundle as unknown as {
			artifacts: Array<{
				id: string;
				actionBindings: Array<{
					actionId: string;
					structure?: string;
					operationId?: string;
					rowInput?: Record<string, unknown>;
					confidentialFields?: string[];
				}>;
				collections?: Array<{
					source: string;
					rowActions: Array<{ actionId: string }>;
					create?: { actionId: string };
				}>;
			}>;
		}
	).artifacts.find((a) => a.id === "settings.ai-connections")!;
	const action = (id: string) =>
		ai.actionBindings.find((a) => a.actionId === id)!;
	expect(
		ai.collections!.map((c) => [
			c.source,
			c.create?.actionId,
			c.rowActions.map((r) => r.actionId),
		]),
	).toEqual([
		["settings-connections", "add-connection", ["delete-connection"]],
		["settings-resources", "add-resource", ["delete-resource"]],
		["inference-probe-targets", undefined, ["probe"]],
		["inference-probes", undefined, ["probe-cancel"]],
	]);
	expect(action("add-connection").rowInput).toEqual({
		connectionId: { generate: "uuid" },
		resourceId: { generate: "uuid" },
	});
	expect(action("add-connection").confidentialFields).toEqual(["apiKey"]);
	expect(action("delete-connection").rowInput).toEqual({
		connectionId: "$row.id",
	});
	expect(action("probe").operationId).toBe("inference.probe-start");
	expect(action("probe-cancel").rowInput).toEqual({ id: "$row.id" });
});

test("the connection form registers a connection alone or with its first model in one apply", async () => {
	const h = await setup();
	const alone = crypto.randomUUID();
	// The form always carries a generated model id; without a purpose it adds no model.
	await apply(h, {
		expectedRevision: rev(h),
		structural: [
			structure(
				ADD_CONNECTION,
				connectionInput(alone, {
					envRef: "EUMENES_CLOUD_A",
					resourceId: crypto.randomUUID(),
				}),
			),
		],
	});
	expect(h.settings.get().resources).toEqual([]);
	const withModel = crypto.randomUUID();
	const modelId = crypto.randomUUID();
	await apply(h, {
		expectedRevision: rev(h),
		structural: [
			structure(
				ADD_CONNECTION,
				connectionInput(withModel, {
					envRef: "EUMENES_CLOUD_B",
					resourceId: modelId,
					purpose: "tts",
					model: "tts-9",
					voice: "alloy",
					assign: true,
				}),
			),
		],
	});
	expect(h.settings.get().resources).toEqual([
		expect.objectContaining({
			id: modelId,
			connectionId: withModel,
			purpose: "tts",
			voice: "alloy",
		}),
	]);
	expect(h.settings.get().routes.tts.fallbackId).toBe(modelId);
	// A purpose without a model name is refused as input.
	expect(
		await codeOf(
			apply(h, {
				expectedRevision: rev(h),
				structural: [
					structure(
						ADD_CONNECTION,
						connectionInput(crypto.randomUUID(), {
							envRef: "EUMENES_CLOUD_C",
							resourceId: crypto.randomUUID(),
							purpose: "llm",
						}),
					),
				],
			}),
		),
	).toBe("invalid_input");
});

test("the probe row is offered for enabled targets and a clean draft, and the key field can be unset", () => {
	const ai = (
		bundle as unknown as {
			artifacts: Array<{
				id: string;
				fields: Array<{
					fieldId: string;
					help?: string;
					unset?: string;
					confidential?: boolean;
				}>;
				collections: Array<{
					source: string;
					description?: string;
					rowActions: Array<Record<string, unknown>>;
					refreshWhile?: { in: string[] };
					create?: { fields: Array<{ fieldId: string }> };
				}>;
			}>;
		}
	).artifacts.find((a) => a.id === "settings.ai-connections")!;
	const probe = ai.collections.find(
		(c) => c.source === "inference-probe-targets",
	)!;
	expect(probe.rowActions).toEqual([
		{
			actionId: "probe",
			when: { key: "enabled", in: [true] },
			requiresCleanDraft: "document:settings@1",
		},
	]);
	expect(
		ai.collections.find((c) => c.source === "inference-probes")!.refreshWhile
			?.in,
	).toEqual(["running", "cancelling"]);
	expect(
		ai.collections
			.find((c) => c.source === "settings-connections")!
			.create!.fields.map((f) => f.fieldId),
	).toEqual(
		expect.arrayContaining([
			"purpose",
			"model",
			"contextWindow",
			"voice",
			"assign",
		]),
	);
	// The cloud-send notice sits on the connections collection, not on a route field.
	expect(
		ai.collections.find((c) => c.source === "settings-connections")!
			.description,
	).toMatch(/^クラウドへの自動切替は初期値で有効です。/);
	expect(
		ai.fields.find((f) => f.fieldId === "route.llm.mode")!.help,
	).toBeUndefined();
	const key = ai.fields.find((f) => f.fieldId === "connection.api-key")!;
	expect(key).toMatchObject({ confidential: true, unset: "null" });
});
