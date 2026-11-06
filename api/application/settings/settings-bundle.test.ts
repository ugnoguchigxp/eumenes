import { expect, test } from "bun:test";
import { createCapabilities } from "../../domains/capabilities";
import {
	createActionRequests,
	createAdapterRegistry,
} from "../../domains/tool-runtime";
import { offlineBundleHost } from "../toolchain/toolchain-adapters";
import { createInferenceAdapter } from "./inference-adapter";
import {
	createSettingsAdapter,
	describeSettingsAdapter,
	publishedSettingsFields,
} from "./settings-adapter";

import {
	ADD_CONNECTION,
	bundle,
	connectionInput,
	createSettingsAdapterFixture,
	registered,
	structure,
	uuid,
} from "./settings-adapter.fixture";
const { setup, apply, codeOf, rev, withModels } =
	createSettingsAdapterFixture();
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
		mode: "larm-only",
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
			artifactRevisionId: "artifact:settings.ai-connections@9",
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
