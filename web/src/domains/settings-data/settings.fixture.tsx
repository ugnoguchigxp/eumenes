import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { vi } from "vitest";
import type { ArtifactDefinitionV1 } from "../../../../api/domains/capabilities/contracts";
import {
	asrLanguages,
	settingsSchema,
	type Settings,
} from "../../../../api/domains/settings/contracts";
import type { EumenesClient } from "../../../../client";
import { queryRoots } from "../../queryKeys";
import { settingsFixture } from "../settings/sections/fixture";
import type { JsonValue } from "../toolchain-artifacts/drafts";
import { writePath } from "../toolchain-artifacts/paths";
import { createWebAdapterRegistry } from "../toolchain-artifacts/registry";
import { ToolchainArtifactHost } from "../toolchain-artifacts/ToolchainArtifactHost";
import { settingsWebAdapter } from "./adapter";
import { recordsWebAdapter } from "./records-adapter";
import type { Field } from "./settings-definitions.fixture";

import { rev, settingsArtifacts } from "./settings-definitions.fixture";
export function createSettingsBackend(
	options: {
		cloud?: boolean;
		/** Explicit current-schema document for tests independent of legacy screen fixtures. */
		initial?: Settings;
		/** Also saves a Claude Agent SDK connection using a subscription, with one model. */
		claude?: boolean;
		/** The registrations to serve (default: the fixture's); keys are `settings.<key>` ids. */
		artifacts?: Record<string, ArtifactDefinitionV1>;
	} = {},
) {
	const artifacts = options.artifacts ?? settingsArtifacts;
	const entries = Object.entries(artifacts).map(([key, artifact]) => ({
		artifactRevisionId: rev(key),
		title: artifact.title,
		adapterRef: artifact.sourceBindings[0]!.adapterRef,
		launcher: artifact.launcher,
	}));
	let saved: Settings = options.initial
		? structuredClone(options.initial)
		: settingsFixture();
	saved.larm.profile = "test-profile";
	saved.larm.baseUrl = "http://127.0.0.1:9001";
	const original = structuredClone(saved);
	const cloud = { connectionId: crypto.randomUUID(), id: crypto.randomUUID() };
	const claude = { connectionId: crypto.randomUUID(), id: crypto.randomUUID() };
	if (options.claude) {
		saved.connections.push({
			id: claude.connectionId,
			kind: "claude-agent-sdk",
			auth: "subscription",
			name: "Claude購読",
			baseUrl: "https://claude.example.test",
			enabled: true,
			epoch: 0,
			envRef: null,
		});
		saved.resources.push({
			id: claude.id,
			connectionId: claude.connectionId,
			purpose: "llm",
			model: "agent-model",
			contextWindow: 8192,
			voice: null,
		});
	}
	if (options.cloud !== undefined) {
		saved.connections.push({
			id: cloud.connectionId,
			name: "クラウド音声",
			baseUrl: "https://example.test/v1",
			enabled: true,
			epoch: 0,
			envRef: null,
		});
		saved.resources.push({
			id: cloud.id,
			connectionId: cloud.connectionId,
			purpose: "tts",
			model: "multilingual",
			voice: "alloy",
			contextWindow: null,
		});
		saved.routes.tts.fallbackId = cloud.id;
		if (options.cloud) saved.routes.tts.mode = "cloud-only";
	}
	/** The settings adapter reads the wire strings back into the document's types. */
	function decode(field: Field, wire: string): JsonValue {
		switch (field.control) {
			case "toggle":
				return wire === "true";
			case "range":
			case "number":
				return Number(wire);
			case "multiple":
				return JSON.parse(wire) as string[];
			default:
				return wire;
		}
	}

	const allFields = Object.values(artifacts).flatMap((a) => a.fields ?? []);
	const sent: Array<{ input: Record<string, unknown>; eventId: string }> = [];
	/** What the fake adapter was asked to confirm and to store as credentials. */
	const confirmedOrigins: string[] = [];
	const storedKeys: unknown[] = [];
	const records = {
		usage: { items: [] as unknown[], total: 0, pageIndex: 0, pageSize: 10 },
		selections: {
			items: [] as unknown[],
			total: 0,
			pageIndex: 0,
			pageSize: 10,
		},
		recipes: [] as Array<Record<string, unknown>>,
		/** The `params` of every records source read, in order. */
		reads: [] as Array<{ source: string; params: unknown }>,
	};
	const recipePage = () => ({
		items: records.recipes,
		total: records.recipes.length,
		pageIndex: 0,
		pageSize: 10,
	});
	const settledView = (eventId: string, receipt?: unknown) => ({
		httpStatus: 200,
		view: {
			eventId,
			status: "accepted" as const,
			createdAt: new Date().toISOString(),
			result: {
				version: 1,
				executionId: "e",
				artifactRevisionId: rev("changes"),
				outcome: "completed",
				resultRefs: [],
				artifactRefs: [],
				...(receipt ? { receipt } : {}),
			},
		},
	});
	const submit = vi.fn(
		async (event: { eventId: string; actionId?: string; input: unknown }) => {
			if (event.actionId === "records-procedure-state") {
				const { id, enabled } = event.input as { id: string; enabled: boolean };
				records.recipes = records.recipes.map((r) => ({
					...r,
					state: enabled ? "active" : "disabled",
				}));
				return settledView(event.eventId, {
					kind: "recipe-state",
					id,
					state: enabled ? "active" : "disabled",
				});
			}
			if (event.actionId === "records-procedure-delete") {
				const { id } = event.input as { id: string };
				records.recipes = [];
				return settledView(event.eventId, { kind: "recipe-delete", id });
			}
			const input = event.input as {
				expectedRevision: number;
				changes: Array<{
					fieldId: string;
					target?: string;
					value?: string;
					unset?: true;
				}>;
				structural?: Array<{
					structure: string;
					input: Record<string, string>;
				}>;
				keys?: Array<{ connectionId: string; value?: string; delete?: true }>;
			};
			sent.push({ input: input as never, eventId: event.eventId });
			if (input.expectedRevision !== saved.revision)
				return {
					httpStatus: 200,
					view: {
						eventId: event.eventId,
						status: "rejected" as const,
						errorCode: "revision_conflict",
						createdAt: new Date().toISOString(),
					},
				};
			const next = structuredClone(saved);
			// Structural operations first, then the field changes (as the real adapter does).
			for (const op of input.structural ?? []) {
				const i = op.input;
				if (
					[
						"structure:settings.add-connection@1",
						"structure:settings.add-connection@2",
					].includes(op.structure)
				)
					next.connections.push({
						id: i.connectionId!,
						name: i.name!,
						baseUrl:
							i.kind === "cloudflare-workers-ai"
								? "https://api.cloudflare.com/client/v4"
								: i.baseUrl!,
						...(i.kind
							? { kind: i.kind as Settings["connections"][number]["kind"] }
							: {}),
						...(i.accountId ? { accountId: i.accountId } : {}),
						enabled: true,
						epoch: 0,
						envRef: null,
					});
				else if (
					[
						"structure:settings.add-resource@1",
						"structure:settings.add-resource@2",
					].includes(op.structure)
				) {
					next.resources.push({
						id: i.resourceId!,
						connectionId: i.connectionId!,
						purpose: i.purpose as "asr" | "tts",
						model: i.model!,
						contextWindow: null,
						voice: i.voice ?? null,
						...(i.language ? { language: i.language } : {}),
					});
				} else if (op.structure === "structure:settings.delete-connection@1") {
					next.connections = next.connections.filter(
						(c) => c.id !== i.connectionId,
					);
					const gone = new Set(
						next.resources
							.filter((r) => r.connectionId === i.connectionId)
							.map((r) => r.id),
					);
					next.resources = next.resources.filter((r) => !gone.has(r.id));
					// Routes that pointed at a removed model fall back to none.
					for (const route of Object.values(next.routes))
						if (route.fallbackId && gone.has(route.fallbackId))
							route.fallbackId = null;
				} else if (op.structure === "structure:settings.confirm-larm-origin@1")
					confirmedOrigins.push(i.origin!);
			}
			for (const key of input.keys ?? []) storedKeys.push(key);
			for (const change of input.changes) {
				const registered = allFields.find((f) => f.fieldId === change.fieldId)!;
				writePath(
					next,
					registered.path,
					change.target,
					change.unset
						? { unset: true }
						: { value: decode(registered, change.value!) },
				);
			}
			next.revision++;
			saved = settingsSchema.parse(next);
			return {
				httpStatus: 200,
				view: {
					eventId: event.eventId,
					status: "accepted" as const,
					createdAt: new Date().toISOString(),
					result: {
						version: 1,
						executionId: "e",
						artifactRevisionId: rev("changes"),
						outcome: "completed",
						resultRefs: [],
						artifactRefs: [],
					},
				},
			};
		},
	);
	const client = {
		identity: crypto.randomUUID(),
		connectionModels: vi.fn(async () => ({
			models: [],
			account: { auth: "api-key", subscriptionType: null },
		})),
		settings: vi.fn(async () => saved),
		toolchainArtifacts: vi.fn(async () => entries),
		toolchainArtifact: vi.fn(async (revisionId: string) => {
			const key = Object.keys(artifacts).find((k) => rev(k) === revisionId)!;
			return {
				artifact: artifacts[key]!,
				artifactRevisionId: revisionId,
				digest: "d",
				scopeRef: "scope:main",
			};
		}),
		toolchainArtifactSource: vi.fn(
			async (
				_rev: string,
				source: string,
				_target?: string,
				_signal?: AbortSignal,
				params?: unknown,
			) => {
				if (params !== undefined) records.reads.push({ source, params });
				switch (source) {
					case "settings-tts-resources":
						return {
							revision: saved.revision,
							data: {
								localAvailable: saved.routes.tts.mode !== "cloud-only",
								targets: saved.resources
									.filter((r) => r.purpose === "tts")
									.map((r) => ({
										id: r.id,
										label: `${saved.connections.find((c) => c.id === r.connectionId)?.name} / ${r.model}`,
										selectLabel: `${saved.connections.find((c) => c.id === r.connectionId)?.name} / ${r.model}（${saved.routes.tts.fallbackId === r.id ? "割当済み" : "未割当"}）`,
									})),
							},
						};
					case "settings-connections":
						return {
							revision: saved.revision,
							data: {
								targets: saved.connections.map((c) => ({
									id: c.id,
									label: c.name,
									baseUrl: c.baseUrl,
								})),
								options: saved.connections.map((c) => ({
									value: c.id,
									label: c.name,
								})),
							},
						};
					case "settings-asr-languages":
						return {
							revision: 0,
							data: {
								options: asrLanguages.map(([value, label]) => ({
									value,
									label,
								})),
							},
						};
					case "settings-records":
						return { revision: 0, data: records.usage };
					case "records-selections":
						return { revision: 0, data: records.selections };
					case "records-recipes":
						return { revision: 0, data: recipePage() };
					case "records-diagnostics":
						return { revision: 0, data: { keyError: null, connections: [] } };
					default:
						return {
							revision: 0,
							data: { diagnostics: {}, larm: {}, usage: [] },
						};
				}
			},
		),
		toolchainInteractions: vi.fn(async () => []),
		submitToolchainAction: submit,
		toolchainAction: vi.fn(),
		unsettledToolchainActions: vi.fn(async () => []),
		larmVoices: vi.fn(),
		voiceSample: vi.fn(
			async (_voice: unknown, _signal?: AbortSignal) =>
				new Uint8Array([1, 2, 3]),
		),
	};
	return {
		artifacts,
		client: client as unknown as EumenesClient & typeof client,
		cloud,
		claude,
		original,
		sent,
		confirmedOrigins,
		storedKeys,
		records,
		saved: () => saved,
		setSaved(next: Settings) {
			saved = next;
		},
	};
}
export type SettingsBackend = ReturnType<typeof createSettingsBackend>;

const adapters = createWebAdapterRegistry([
	settingsWebAdapter,
	recordsWebAdapter,
]);

/** The workspace in miniature: one tab at a time, navigate bindings switch the artifact. */
export function Screens({
	backend,
	start,
	cache,
}: {
	backend: SettingsBackend;
	start: string;
	cache: QueryClient;
}) {
	const [current, setCurrent] = useState<string | null>(start);
	const [navigations, setNavigations] = useState<string[]>([]);
	return (
		<QueryClientProvider client={cache}>
			<button type="button" onClick={() => setCurrent(null)}>
				閉じる
			</button>
			{Object.keys(backend.artifacts).map((key) => (
				<button type="button" key={key} onClick={() => setCurrent(key)}>
					{`開く:${key}`}
				</button>
			))}
			<output aria-label="移動履歴">{navigations.join(",")}</output>
			{current && (
				<ToolchainArtifactHost
					key={current}
					client={backend.client}
					adapters={adapters}
					artifactRevisionId={rev(current)}
					artifactId={`tab-${current}`}
					onNavigate={(artifactId) => {
						const key = Object.keys(backend.artifacts).find(
							(k) => `settings.${k}` === artifactId,
						);
						setNavigations((list) => [...list, artifactId]);
						if (!key) return false;
						setCurrent(key);
						return true;
					}}
				/>
			)}
		</QueryClientProvider>
	);
}

export function newCache(backend: SettingsBackend, saved = backend.saved()) {
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	cache.setQueryData([queryRoots.settings, backend.client.identity], saved);
	return cache;
}
