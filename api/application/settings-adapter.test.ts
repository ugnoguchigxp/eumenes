import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCapabilities } from "../domains/capabilities";
import {
	createActionRequests,
	createAdapterRegistry,
} from "../domains/tool-runtime";
import { createSettings } from "../domains/settings";
import { type Settings } from "../domains/settings/contracts";
import { openStore, type SqliteStore } from "../infrastructure/sqlite";
import { migrations } from "./migrations";
import {
	createSettingsAdapter,
	describeSettingsAdapter,
	describeSettingsPath,
	publishedSettingsFields,
	settingsConditions,
	settingsLeaf,
	type SettingsField,
} from "./settings-adapter";
import { offlineBundleHost } from "./toolchain-adapters";

type BundleField = SettingsField & { visibleWhen?: string };
const bundle = JSON.parse(
	readFileSync(
		join(
			import.meta.dir,
			"../domains/capabilities/bundles/settings.bundle.json",
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
		inputSchemaRef: "schema:settings-apply@1",
		effect: "write",
	});
	expect([...d.queries].sort()).toEqual([
		"query:settings.asr-languages@1",
		"query:settings.document@1",
		"query:settings.tts-resources@1",
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
		"$.general.asrLanguages",
		"$.larm.voice",
		"$.voice.silenceMs",
		"$.routes.llm.mode",
		"$.codingSupervision.approveInstructions",
		"$.resources[id=$target].voice",
		"$.resources[id=$target].speed",
		"$.connections[id=$target].name",
		"$.connections[id=$target].agentId",
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
			{ fieldId: "input.languages", value: '["ja","ko"]' },
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
	expect(saved.general.asrLanguages).toEqual(["ja", "ko"]);
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
	expect(await code([{ fieldId: "input.languages", value: "[]" }])).toBe(
		"invalid_settings",
	);
	expect(await code([{ fieldId: "input.languages", value: "ja" }])).toBe(
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
	const languages = read("query:settings.asr-languages@1")!.data as {
		options: Array<{ value: string; label: string }>;
	};
	expect(languages.options).toHaveLength(30);
	expect(languages.options[0]).toEqual({ value: "ja", label: "日本語" });
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
			artifactRevisionId: "artifact:settings.conversation@1",
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
	expect(info("$.general.asrLanguages")).toMatchObject({ kind: "array" });
	expect(info("$.general.asrLanguages").values).toContain("ja");
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
