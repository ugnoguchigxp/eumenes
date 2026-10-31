import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type SqliteStore } from "../../infrastructure/sqlite";
import { createSettings } from "../../domains/settings";
import { migrations } from "../migrations";
import {
	createSettingsAdapter,
	describeSettingsAdapter,
	settingsConditions,
	type SettingsField,
} from "./settings-adapter";
import { offlineBundleHost } from "../toolchain/toolchain-adapters";
let store: SqliteStore | undefined;
let dir = "";
afterEach(async () => {
	await store?.close();
	store = undefined;
	if (dir) rmSync(dir, { recursive: true, force: true });
});
async function setup() {
	dir = mkdtempSync(join(tmpdir(), "eumenes-live-settings-"));
	const dbPath = join(dir, "db");
	store = openStore(dbPath, migrations);
	const settings = await createSettings(store, { dbPath, env: {} });
	const bundle = JSON.parse(
		readFileSync(
			join(
				import.meta.dir,
				"../../domains/capabilities/bundles/settings.live.bundle.json",
			),
			"utf8",
		),
	) as { artifacts: Array<{ fields?: SettingsField[] }> };
	const fields = new Map(
		bundle.artifacts.flatMap((a) => a.fields ?? []).map((f) => [f.fieldId, f]),
	);
	for (const field of fields.values())
		expect(
			describeSettingsAdapter()
				.documents.get("document:settings@1")!
				.describePath(field.path),
		).not.toBeNull();
	const adapter = createSettingsAdapter(settings, {
		fields: (_tx, id) => fields.get(id),
	});
	return { store, settings, adapter };
}
function apply(h: Awaited<ReturnType<typeof setup>>, input: unknown) {
	return h.store.write((db) =>
		h.adapter.invokeInTransaction(db, {
			operationName: "settings.apply",
			input,
			requestId: crypto.randomUUID(),
			issuedAt: new Date().toISOString(),
			origin: {
				kind: "ui",
				scope: "scope",
				actionRequestId: crypto.randomUUID(),
			},
		}),
	);
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
		"query:settings.live-connections@1",
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

test("the registered Live fields save through the common draft contract and the connection source admits only enabled official connections", async () => {
	const h = await setup();
	const doc = h.settings.get();
	const official = crypto.randomUUID(),
		proxy = crypto.randomUUID(),
		disabled = crypto.randomUUID();
	doc.connections.push(
		...[
			{
				id: official,
				name: "公式",
				baseUrl: "https://api.openai.com/v1",
				enabled: true,
			},
			{
				id: proxy,
				name: "互換",
				baseUrl: "https://api.example.com/v1",
				enabled: true,
			},
			{
				id: disabled,
				name: "停止",
				baseUrl: "https://api.openai.com/v1",
				enabled: false,
			},
		].map((c) => ({ ...c, epoch: 0, envRef: null })),
	);
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: doc.revision,
		settings: doc,
		keys: [],
	});
	const options = h.store.read((tx) =>
		h.adapter.sourceInTransaction(
			tx,
			"query:settings.live-connections@1",
			undefined,
		),
	)!.data;
	expect(options).toEqual({ options: [{ value: official, label: "公式" }] });
	await apply(h, {
		expectedRevision: h.settings.get().revision,
		changes: [
			{ fieldId: "live.enabled", value: "true" },
			{ fieldId: "live.connection", value: official },
			{ fieldId: "live.model", value: "fixture-runtime-id" },
		],
	});
	expect(h.settings.get().live).toMatchObject({
		enabled: true,
		connectionId: official,
		model: "fixture-runtime-id",
		cloudAllowed: false,
	});
});
