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
import { settingsFixture } from "../settings/sections/fixture";
import { queryRoots } from "../../queryKeys";
import { createWebAdapterRegistry } from "../toolchain-artifacts/registry";
import { ToolchainArtifactHost } from "../toolchain-artifacts/ToolchainArtifactHost";
import type { JsonValue } from "../toolchain-artifacts/drafts";
import { writePath } from "../toolchain-artifacts/paths";
import { settingsWebAdapter, SETTINGS_DOCUMENT } from "./adapter";
import { recordsWebAdapter } from "./records-adapter";

/** A test stand-in for the settings bundle: the registrations the Web adapter is built for. */
const ADAPTER = "adapter:settings@1";
const DOC = SETTINGS_DOCUMENT;
const TTS = "query:settings.tts-resources@1";
const rev = (id: string) => `artifact:settings.${id}@1`;

type Field = NonNullable<ArtifactDefinitionV1["fields"]>[number];
const field = (
	f: Partial<Field> & Pick<Field, "fieldId" | "path" | "label" | "control">,
): Field => ({
	document: DOC,
	...f,
});

export const conversationFields: Field[] = [
	field({
		fieldId: "conversation.agent-name",
		path: "$.general.agentName",
		label: "AIの名前",
		control: "text",
		maxLength: 40,
		help: "空欄の場合は名前を設定しません。",
	}),
	field({
		fieldId: "conversation.user-name",
		path: "$.general.userName",
		label: "あなたの名前",
		control: "text",
		maxLength: 40,
	}),
	field({
		fieldId: "conversation.persona",
		path: "$.general.persona",
		label: "口調",
		control: "select",
		options: [
			{ value: "butler", label: "執事" },
			{ value: "maid", label: "メイド" },
			{ value: "strategist", label: "参謀" },
			{ value: "sage", label: "老師" },
		],
	}),
];
export const displayFields: Field[] = [
	field({
		fieldId: "display.background",
		path: "$.general.background",
		label: "会話の背景",
		control: "select",
		defaultValue: "light-fairy",
		unset: "delete-key",
		options: [
			{ value: "light-fairy", label: "光の妖精" },
			{ value: "spatial", label: "Spatial" },
		],
	}),
	field({
		fieldId: "display.theme",
		path: "$.general.theme",
		label: "テーマ",
		control: "select",
		options: [
			{ value: "system", label: "端末の設定に合わせる" },
			{ value: "light", label: "ライト" },
			{ value: "dark", label: "ダーク" },
		],
	}),
	field({
		fieldId: "display.subtitles.enabled",
		path: "$.general.subtitles.enabled",
		label: "読み上げ字幕を表示する",
		control: "toggle",
	}),
	field({
		fieldId: "display.subtitles.style",
		path: "$.general.subtitles.style",
		label: "字幕のデザイン",
		control: "select",
		options: [
			{ value: "netflix", label: "シネマ（白文字・影）" },
			{ value: "prime", label: "ボックス（半透明の黒背景）" },
			{ value: "classic", label: "クラシック（黄文字・黒縁）" },
			{ value: "glass", label: "ガラス（ぼかし背景）" },
		],
	}),
	field({
		fieldId: "display.subtitles.size",
		path: "$.general.subtitles.size",
		label: "字幕の大きさ",
		control: "select",
		options: [
			{ value: "medium", label: "中" },
			{ value: "large", label: "大" },
			{ value: "xlarge", label: "特大" },
		],
	}),
];
export const voiceFields: Field[] = [
	field({
		fieldId: "speech.enabled",
		path: "$.voice.autoSpeak",
		label: "回答を読み上げる",
		control: "toggle",
		group: "speech",
	}),
	field({
		fieldId: "speech.volume",
		path: "$.voice.outputVolume",
		label: "音量",
		control: "range",
		group: "speech",
		min: 0,
		max: 1,
		step: 0.05,
	}),
	field({
		fieldId: "speech.barge-in",
		path: "$.voice.bargeIn",
		label: "話し始めたら読み上げを止める",
		control: "toggle",
		group: "speech",
	}),
	field({
		fieldId: "input.languages",
		path: "$.general.asrLanguages",
		label: "利用する言語",
		control: "multiple",
		group: "input",
		optionsSource: "query:settings.asr-languages@1",
	}),
	field({
		fieldId: "input.threshold",
		path: "$.voice.threshold",
		label: "声を検出するしきい値",
		control: "number",
		group: "input",
		detail: true,
		min: 0.001,
		max: 0.1,
		step: 0.001,
	}),
	field({
		fieldId: "input.silence-ms",
		path: "$.voice.silenceMs",
		label: "発話を確定する無音時間（ミリ秒）",
		control: "number",
		group: "input",
		detail: true,
		min: 300,
		max: 3000,
		step: 100,
	}),
	field({
		fieldId: "input.echo",
		path: "$.voice.echoCancellation",
		label: "エコーを抑える",
		control: "toggle",
		group: "input",
		detail: true,
	}),
	field({
		fieldId: "input.noise",
		path: "$.voice.noiseSuppression",
		label: "周囲の雑音を抑える",
		control: "toggle",
		group: "input",
		detail: true,
	}),
	field({
		fieldId: "input.gain",
		path: "$.voice.autoGainControl",
		label: "マイクの音量を自動調整する",
		control: "toggle",
		group: "input",
		detail: true,
	}),
	field({
		fieldId: "input.device",
		path: "$.voice.inputDevice",
		options: [{ value: "", label: "システム標準" }],
		label: "マイク",
		control: "select",
		group: "devices",
	}),
	field({
		fieldId: "output.device",
		path: "$.voice.outputDevice",
		options: [{ value: "", label: "システム標準" }],
		label: "再生機器",
		control: "select",
		group: "devices",
		visibleWhen: "condition:settings.output-device-selectable@1",
	}),
	field({
		fieldId: "speech.local.voice",
		path: "$.larm.voice",
		options: [{ value: "", label: "サービスの既定のキャラクター" }],
		label: "キャラクター",
		control: "select",
		group: "speech",
		searchable: true,
		visibleWhen: "condition:settings.speech-local@1",
	}),
	field({
		fieldId: "speech.local.style",
		path: "$.larm.style",
		options: [{ value: "", label: "サービスの標準" }],
		label: "話し方（スタイル）",
		control: "select",
		group: "speech",
		detail: true,
		unset: "delete-key",
		visibleWhen: "condition:settings.larm-style@1",
	}),
	field({
		fieldId: "speech.local.speed",
		path: "$.larm.speed",
		defaultValue: "1",
		label: "話す速さ",
		control: "range",
		group: "speech",
		step: 0.1,
		unset: "delete-key",
		visibleWhen: "condition:settings.larm-speed@1",
	}),
	field({
		fieldId: "speech.local.pitch",
		path: "$.larm.pitchScale",
		defaultValue: "0",
		label: "声の高さ",
		control: "range",
		group: "speech",
		detail: true,
		step: 0.01,
		unset: "delete-key",
		visibleWhen: "condition:settings.larm-pitch@1",
	}),
	field({
		fieldId: "speech.local.intonation",
		path: "$.larm.intonationScale",
		defaultValue: "1",
		label: "抑揚",
		control: "range",
		group: "speech",
		detail: true,
		step: 0.05,
		unset: "delete-key",
		visibleWhen: "condition:settings.larm-intonation@1",
	}),
	field({
		fieldId: "speech.local.auto",
		path: "$.larm.autoIntonation",
		defaultValue: "false",
		label: "文章に合わせて抑揚・速さ・高さを変える（簡易）",
		control: "toggle",
		group: "speech",
		detail: true,
		unset: "delete-key",
		visibleWhen: "condition:settings.larm-intonation@1",
	}),
	field({
		fieldId: "speech.local.strength",
		path: "$.larm.autoStrength",
		defaultValue: "1",
		label: "自動調整の強さ",
		control: "range",
		group: "speech",
		detail: true,
		min: 0,
		max: 2,
		step: 0.05,
		unset: "delete-key",
		visibleWhen: "condition:settings.larm-auto-strength@1",
	}),
	field({
		fieldId: "speech.cloud.voice",
		path: "$.resources[id=$target].voice",
		target: "settings-tts-resources",
		label: "音声ID",
		control: "text",
		group: "speech",
		maxLength: 200,
		help: "サービスが提供する音声IDを入力してください。",
	}),
	field({
		fieldId: "speech.cloud.speed",
		path: "$.resources[id=$target].speed",
		target: "settings-tts-resources",
		defaultValue: "1",
		label: "話す速さ",
		control: "range",
		group: "speech",
		min: 0.5,
		max: 2,
		step: 0.1,
	}),
];

type Binding = ArtifactDefinitionV1["actionBindings"][number];
const edit = (source: string): Binding => ({
	actionId: `edit-${source}`,
	eventAction: "settings-edit",
	source,
	inputSchemaRef: "builtin:emptyInput",
	effect: "draft",
	draftAction: "edit",
	draftDocument: DOC,
});
const apply = (source: string): Binding => ({
	actionId: `apply-${source}`,
	eventAction: "settings-apply",
	source,
	operationId: "settings.apply",
	inputSchemaRef: "builtin:settingsApply",
	effect: "write",
	draftDocument: DOC,
	confidentialFields: ["keys"],
});
const review = (source: string): Binding => ({
	actionId: `review-${source}`,
	eventAction: "settings-review",
	source,
	inputSchemaRef: "builtin:emptyInput",
	effect: "navigate",
	navigateTo: { artifactId: "settings.changes" },
});
const settingsSource = (
	source: string,
	target: "none" | "optional" = "none",
) => ({
	source,
	adapterRef: ADAPTER,
	query: "query:settings.document@1",
	target,
});
const base = (
	id: string,
	title: string,
	group?: string,
	description?: string,
) => ({
	kind: "artifact" as const,
	id: `settings.${id}`,
	revision: 1,
	title,
	defaultVariant: "standard",
	launcher: {
		label: title,
		...(group ? { group } : {}),
		...(description ? { description } : {}),
	},
});
const variant = (definition: unknown) => [
	{ id: "standard", label: "標準", definition },
];

export const aiFields: Field[] = [
	field({
		fieldId: "larm.url",
		path: "$.larm.baseUrl",
		label: "LARMのURL",
		control: "text",
		group: "larm",
		maxLength: 2048,
		unset: "null",
	}),
	field({
		fieldId: "connection.name",
		path: "$.connections[id=$target].name",
		target: "settings-connections",
		label: "接続名",
		control: "text",
		group: "connection",
		maxLength: 80,
	}),
	field({
		fieldId: "connection.enabled",
		path: "$.connections[id=$target].enabled",
		target: "settings-connections",
		label: "この接続を有効にする",
		control: "toggle",
		group: "connection",
	}),
	field({
		fieldId: "connection.api-key",
		path: "$.connections[id=$target].apiKey",
		target: "settings-connections",
		label: "APIキーの更新",
		control: "text",
		group: "connection",
		confidential: true,
		unset: "null",
	}),
];

const structure = (
	actionId: string,
	structureRef: string,
	label: string,
	source: string,
	rowInput?: Binding["rowInput"],
): Binding => ({
	actionId,
	eventAction: actionId,
	source,
	inputSchemaRef: "builtin:emptyInput",
	effect: "draft",
	draftAction: "structure",
	structure: structureRef,
	draftDocument: DOC,
	label,
	...(rowInput ? { rowInput } : {}),
});

export const settingsArtifacts: Record<string, ArtifactDefinitionV1> = {
	hub: {
		...base("hub", "設定"),
		launcher: { label: "設定" },
		variants: variant({
			view: "settings-navigation",
			source: "settings-hub",
			title: "設定",
		}),
		sourceBindings: [settingsSource("settings-hub")],
		actionBindings: [
			{
				actionId: "open",
				eventAction: "settings-open",
				source: "settings-hub",
				inputSchemaRef: "builtin:emptyInput",
				effect: "navigate",
				navigateTo: {
					byValue: "id",
					artifacts: {
						conversation: "settings.conversation",
						voice: "settings.voice-input",
						display: "settings.display",
						records: "settings.records",
					},
				},
			},
			review("settings-hub"),
		],
	},
	conversation: {
		...base(
			"conversation",
			"会話",
			"使い方を変える",
			"AIの名前 あなたの名前 口調",
		),
		variants: variant({
			view: "settings-section",
			source: "settings-conversation",
			title: "会話",
		}),
		sourceBindings: [settingsSource("settings-conversation")],
		actionBindings: [
			edit("settings-conversation"),
			apply("settings-conversation"),
			review("settings-conversation"),
		],
		fields: conversationFields,
	},
	display: {
		...base("display", "表示", "使い方を変える", "背景 テーマ 字幕"),
		variants: variant({
			view: "layout",
			direction: "stack",
			title: "表示の設定",
			children: [
				{ view: "settings-section", source: "settings-display", title: "表示" },
				{ view: "subtitle-preview", source: "settings-display-preview" },
			],
		}),
		sourceBindings: [
			settingsSource("settings-display"),
			settingsSource("settings-display-preview"),
		],
		actionBindings: [
			edit("settings-display"),
			apply("settings-display"),
			review("settings-display"),
		],
		fields: displayFields,
	},
	"voice-input": {
		...base(
			"voice-input",
			"音声と入力",
			"使い方を変える",
			"読み上げ 聞き取り 機器",
		),
		variants: variant({
			view: "settings-section",
			source: "settings-voice-input",
			title: "音声と入力",
		}),
		sourceBindings: [
			settingsSource("settings-voice-input"),
			{
				source: "settings-tts-resources",
				adapterRef: ADAPTER,
				query: TTS,
				target: "none",
			},
			{
				source: "settings-asr-languages",
				adapterRef: ADAPTER,
				query: "query:settings.asr-languages@1",
				target: "none",
			},
		],
		actionBindings: [
			edit("settings-voice-input"),
			apply("settings-voice-input"),
			review("settings-voice-input"),
			{
				actionId: "action",
				eventAction: "settings-action",
				source: "settings-voice-input",
				inputSchemaRef: "builtin:emptyInput",
				effect: "local",
			},
		],
		fields: voiceFields,
	},
	records: {
		...base("records", "記録", "管理と確認", "AIの利用 ツールチェーン"),
		revision: 2,
		variants: variant({
			view: "records-workspace",
			source: "settings-records",
			title: "記録",
		}),
		sourceBindings: [
			["settings-records", "usage"],
			["records-selections", "selections"],
			["records-recipes", "recipes"],
			["records-diagnostics", "diagnostics"],
			["records-export", "export"],
		].map(([source, name]) => ({
			source: source!,
			adapterRef: "adapter:records@1",
			query: `query:records.${name}@1`,
			target: "none" as const,
		})),
		actionBindings: (
			[
				{ eventAction: "records-refresh", effect: "local" },
				{
					eventAction: "records-procedure-state",
					effect: "write",
					operationId: "records.recipe-state",
				},
				{
					eventAction: "records-procedure-delete",
					effect: "write",
					operationId: "records.recipe-delete",
				},
				{ eventAction: "records-download", effect: "local" },
			] satisfies Array<
				Pick<Binding, "eventAction" | "effect"> & { operationId?: string }
			>
		).map((binding): Binding => ({
			actionId: binding.eventAction,
			source: "settings-records",
			inputSchemaRef: "builtin:emptyInput",
			...binding,
		})),
	},
	"ai-connections": {
		...base(
			"ai-connections",
			"AIと接続",
			"使い方を変える",
			"LARM 利用先 クラウド接続",
		),
		variants: variant({
			view: "layout",
			direction: "stack",
			title: "AIと接続",
			children: [
				{ view: "settings-section", source: "settings-ai", title: "AIと接続" },
				{
					view: "collection-workspace",
					source: "settings-connections",
					title: "クラウド接続",
				},
			],
		}),
		sourceBindings: [
			settingsSource("settings-ai"),
			{
				source: "settings-connections",
				adapterRef: ADAPTER,
				query: "query:settings.connections@1",
				target: "none",
			},
		],
		actionBindings: [
			edit("settings-ai"),
			apply("settings-ai"),
			review("settings-ai"),
			structure(
				"add-connection",
				"structure:settings.add-connection@1",
				"クラウドAPIを登録",
				"settings-connections",
				{ connectionId: { generate: "uuid" } },
			),
			structure(
				"delete-connection",
				"structure:settings.delete-connection@1",
				"接続を削除",
				"settings-connections",
				{ connectionId: "$row.id" },
			),
		],
		collections: [
			{
				source: "settings-connections",
				title: "クラウド接続",
				rowKey: "id",
				rowsPath: "targets",
				columns: [
					{ key: "label", label: "名前", format: "text" },
					{ key: "baseUrl", label: "接続先", format: "text" },
				],
				rowActions: [
					{
						actionId: "delete-connection",
						confirm: "この接続を削除する変更を、変更一覧へ追加します。",
					},
				],
				create: {
					actionId: "add-connection",
					fields: [
						{
							fieldId: "name",
							label: "接続名",
							control: "text",
							required: true,
							maxLength: 80,
						},
						{
							fieldId: "baseUrl",
							label: "APIのベースURL",
							control: "text",
							required: true,
						},
						{
							fieldId: "token",
							label: "APIキー",
							control: "secret",
							confidential: true,
						},
					],
				},
			},
		],
		fields: aiFields,
	},
	changes: {
		...base("changes", "設定の変更一覧", "管理と確認"),
		variants: variant({
			view: "settings-changes",
			source: "settings-changes",
			title: "設定の変更一覧",
		}),
		sourceBindings: [settingsSource("settings-changes")],
		actionBindings: [
			apply("settings-changes"),
			{
				actionId: "discard-settings-changes",
				eventAction: "settings-discard",
				source: "settings-changes",
				inputSchemaRef: "builtin:emptyInput",
				effect: "draft",
				draftAction: "discard",
				draftDocument: DOC,
			},
		],
	},
};

export const artifactRevisionOf = (key: string) => rev(key);

/**
 * A fake backend: the settings document with the same `apply` semantics as the real adapter
 * (revision check, changes applied to the saved document, whole-document schema check).
 */
export function createSettingsBackend(
	options: {
		cloud?: boolean;
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
	let saved: Settings = settingsFixture();
	saved.larm.profile = "ornith1.5Strix";
	saved.larm.baseUrl = "http://127.0.0.1:9001";
	const original = structuredClone(saved);
	const cloud = { connectionId: crypto.randomUUID(), id: crypto.randomUUID() };
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
				if (op.structure === "structure:settings.add-connection@1")
					next.connections.push({
						id: i.connectionId!,
						name: i.name!,
						baseUrl: i.baseUrl!,
						enabled: true,
						epoch: 0,
						envRef: null,
					});
				else if (op.structure === "structure:settings.delete-connection@1") {
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
			{[
				"hub",
				"conversation",
				"display",
				"voice-input",
				"records",
				"changes",
			].map((key) => (
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
