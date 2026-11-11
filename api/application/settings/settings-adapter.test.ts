import { expect, test } from "bun:test";
import { createCapabilities } from "../../domains/capabilities";
import { type Settings } from "../../domains/settings/contracts";
import {
	createActionRequests,
	createAdapterRegistry,
} from "../../domains/tool-runtime";
import { offlineBundleHost } from "../toolchain/toolchain-adapters";
import {
	createSettingsAdapter,
	describeSettingsAdapter,
	describeSettingsPath,
	publishedSettingsFields,
	settingsLeaf,
} from "./settings-adapter";

import {
	createSettingsAdapterFixture,
	registered,
} from "./settings-adapter.fixture";
const { setup, apply, codeOf, rev, withModels } =
	createSettingsAdapterFixture();
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
		"$.resources[id=$target].voice",
		"$.resources[id=$target].speed",
		"$.connections[id=$target].name",
		"$.connections[id=$target].auth",
		"$.world.curationResourceId",
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
			artifactRevisionId: "artifact:settings.conversation@10",
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
		{ fieldId: "agency.runtime", value: "always-on" },
		{ fieldId: "agency.speech-interval", value: "60" },
		{ fieldId: "agency.think-reasoning", value: "high" },
		{ fieldId: "conversation.persona", value: "maid" },
	]);
	expect(accepted.request.status).toBe("accepted");
	expect(accepted.request.result?.resultRefs[0]?.revision).toBe(revision + 1);
	expect(h.settings.get().general).toMatchObject({
		agentName: "アルフレッド",
		persona: "maid",
	});
	expect(h.settings.get().agency).toMatchObject({
		runtime: "always-on",
		speechIntervalSec: 60,
		thinkReasoning: "high",
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
