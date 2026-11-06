import { expect, test } from "bun:test";
import { describeSettingsAdapter } from "./settings-adapter";

import {
	ADD_CONNECTION,
	ADD_RESOURCE,
	bundle,
	CONFIRM_ORIGIN,
	connectionInput,
	createSettingsAdapterFixture,
	DELETE_CONNECTION,
	DELETE_RESOURCE,
	structure,
	uuid,
} from "./settings-adapter.fixture";
const { setup, apply, codeOf, rev, withModels } =
	createSettingsAdapterFixture();
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
	expect(saved.routes.tts.mode).toBe("larm-only");
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

test("deleting a model or connection also frees the dedicated World model that used it", async () => {
	const h = await setup();
	const { connectionId } = await withModels(h);
	const worldModel = uuid();
	await apply(h, {
		expectedRevision: rev(h),
		structural: [
			structure(ADD_RESOURCE, {
				resourceId: worldModel,
				connectionId,
				purpose: "llm",
				model: "world-model",
			}),
		],
	});
	const current = h.settings.get();
	current.world.curationResourceId = worldModel;
	await h.settings.apply({
		requestId: uuid(),
		expectedRevision: current.revision,
		settings: current,
		keys: [],
	});
	await apply(h, {
		expectedRevision: rev(h),
		structural: [structure(DELETE_RESOURCE, { resourceId: worldModel })],
	});
	expect(h.settings.get().world.curationResourceId).toBeNull();
	await apply(h, {
		expectedRevision: rev(h),
		structural: [structure(DELETE_CONNECTION, { connectionId })],
	});
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
	expect(saved.routes.tts.mode).toBe("larm-only");
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
