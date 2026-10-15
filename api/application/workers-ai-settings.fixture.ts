import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openStore } from "../infrastructure/sqlite";
import {
	createCapabilities,
	migrations as capabilityMigrations,
	type BundleHost,
} from "../domains/capabilities";
import {
	createSettings,
	migrations as settingsMigrations,
	registerSettings,
} from "../domains/settings";
import {
	createActionRequests,
	createAdapterRegistry,
	migrations as actionMigrations,
	registerToolchainActions,
} from "../domains/tool-runtime";
import { registerInference } from "../domains/inference/controller";
import type { InferenceService } from "../domains/inference/service";
import { createConnectionModels } from "../domains/inference/service/connection-models";
import {
	createSettingsAdapter,
	describeSettingsAdapter,
	publishedSettingsFields,
} from "./settings-adapter";
import {
	createInferenceAdapter,
	describeInferenceAdapter,
} from "./inference-adapter";
import { describeRecordsAdapter } from "./records-adapter";

/** Isolated settings/action-ledger fixture. It never reads the product DB or sends network requests. */
export async function workersSettingsFixture(legacy = false) {
	const dir = mkdtempSync(join(tmpdir(), "workers-settings-api-"));
	const store = openStore(join(dir, "db"), [
		...settingsMigrations,
		...capabilityMigrations,
		...actionMigrations,
	]);
	const settings = await createSettings(store, {
		dbPath: join(dir, "db"),
		env: {},
	});
	const host = (): BundleHost => ({
		adapters: new Map([
			["adapter:settings@1", describeSettingsAdapter()],
			["adapter:inference@1", describeInferenceAdapter()],
			["adapter:records@1", describeRecordsAdapter()],
		]),
		availability: new Set([
			"availability:settings@1",
			"availability:inference@1",
			"availability:records@1",
		]),
		inputAdapters: new Set(),
		projections: new Set(),
		connections: new Set(),
		domainSchemas: new Set([
			"domain:settings.document@1",
			"domain:inference.probe@1",
			"domain:records.recipe@1",
		]),
	});
	const caps = createCapabilities(store, new Set());
	const bundle = JSON.parse(
		readFileSync(
			new URL(
				"../domains/capabilities/bundles/settings.bundle.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	const imported = await store.write((db) =>
		caps.importBundleInTransaction(
			db,
			legacy
				? {
						...bundle,
						artifacts: bundle.artifacts.filter(
							(a: { id: string; revision: number }) =>
								!bundle.artifacts.some(
									(other: { id: string; revision: number }) =>
										other.id === a.id && other.revision < a.revision,
								),
						),
						schemas: bundle.schemas.filter(
							(s: { id: string; revision: number }) =>
								s.id === "settings-add-resource"
									? s.revision === 1
									: ["settings-apply", "settings-add-connection"].includes(s.id)
										? s.revision <= 3
										: true,
						),
					}
				: bundle,
			host(),
		),
	);
	if (imported.issues.length) throw new Error(JSON.stringify(imported.issues));
	const registry = createAdapterRegistry([
		createSettingsAdapter(settings, {
			fields: publishedSettingsFields(() => caps),
		}),
		createInferenceAdapter(
			{
				probes: () => [],
				getProbe: () => null,
				inspect: () => ({}),
				usage: () => [],
				startProbeInTransaction: () => ({ id: "fixture", launch() {} }),
				cancelProbeInTransaction() {},
				cancelProbe() {},
			},
			settings,
		),
	]);
	const ledger = createActionRequests({
		store,
		capabilities: caps,
		registry,
		scope: "workers-settings-fixture",
		secretKey: () => settings.derivedKey("workers-fixture"),
	});
	const wire: Array<{ url: URL; init?: RequestInit }> = [];
	const send = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		wire.push({ url, init });
		if (url.pathname.endsWith("models/search")) {
			const tts = url.searchParams.get("task") === "Text-to-Speech";
			return Response.json({
				success: true,
				result: [{ name: `@cf/fixture/${tts ? "synthesis" : "recognition"}` }],
			});
		}
		const tts = url.searchParams.get("model")?.endsWith("synthesis");
		return Response.json({
			success: true,
			result: tts
				? {
						input: {
							type: "object",
							properties: {
								text: { type: "string" },
								speaker: { type: "string", enum: ["voice-a", "voice-b"] },
								encoding: { type: "string", enum: ["linear16"] },
								container: { type: "string", enum: ["wav"] },
							},
						},
						output: { type: "string", contentType: "audio/wav" },
					}
				: {
						input: {
							type: "object",
							properties: {
								audio: { type: "string" },
								language: { type: "string" },
							},
							required: ["audio"],
						},
						output: {
							type: "object",
							properties: { text: { type: "string" } },
						},
					},
		});
	}) as typeof fetch;
	const models = createConnectionModels(settings, {}, { fetch: send });
	const app = new Hono();
	app.use("/api/*", async (c, next) => {
		if (
			c.req.header("authorization") !==
			"Bearer fixture-workers-api-browser-token"
		)
			return c.json({ error: "unauthorized" }, 401);
		await next();
	});
	registerSettings(app, settings);
	registerToolchainActions(app, ledger);
	registerInference(app, {} as InferenceService, models);
	return {
		app,
		store,
		settings,
		caps,
		ledger,
		wire,
		bundle,
		host,
		async close() {
			await store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
