import { afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSettings } from "../../domains/settings";
import { type Settings } from "../../domains/settings/contracts";
import { openStore, type SqliteStore } from "../../infrastructure/sqlite";
import { migrations } from "../migrations";
import { createSettingsAdapter, type SettingsField } from "./settings-adapter";

type BundleField = SettingsField & { visibleWhen?: string };
export const bundle = JSON.parse(
	readFileSync(
		join(
			import.meta.dir,
			"../../domains/capabilities/bundles/settings.bundle.json",
		),
		"utf8",
	),
) as { artifacts: Array<{ id: string; fields?: BundleField[] }> };
export const registered = new Map(
	bundle.artifacts.flatMap((a) => a.fields ?? []).map((f) => [f.fieldId, f]),
);

export const ADD_CONNECTION = "structure:settings.add-connection@1";
export const DELETE_CONNECTION = "structure:settings.delete-connection@1";
export const ADD_RESOURCE = "structure:settings.add-resource@1";
export const DELETE_RESOURCE = "structure:settings.delete-resource@1";
export const CONFIRM_ORIGIN = "structure:settings.confirm-larm-origin@1";
export const uuid = () => crypto.randomUUID();
export const connectionInput = (
	id: string,
	extra: Record<string, unknown> = {},
) => ({
	connectionId: id,
	name: "クラウド",
	baseUrl: "https://api.example.com/v1",
	...extra,
});
export const structure = (
	structureRef: string,
	input: Record<string, unknown>,
) => ({
	structure: structureRef,
	input,
});

export function createSettingsAdapterFixture() {
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

	return { setup, apply, codeOf, rev, withModels };
}
