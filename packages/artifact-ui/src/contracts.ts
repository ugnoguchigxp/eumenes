import type { GoogleAccountsResource } from "./google-accounts-components";
import type { OcrResource } from "./ocr-components";
export type { OcrResource } from "./ocr-components";
import type { CollectionResource } from "./collection-contracts";
export type * from "./resource-exports";
import type { ObjectRecognitionResource } from "./object-recognition-components";
import type { TerminalsResource } from "./terminal-components";
import type { KanbanResource } from "./kanban-components";
import type { ActivityResource } from "./activity-components";
export type { KanbanBoardSource, KanbanResource } from "./kanban-components";
export type {
	TerminalConnection,
	TerminalSessionResource,
	TerminalsResource,
} from "./terminal-components";
export type { ObjectRecognitionResource } from "./object-recognition-components";
import type { DrawingResource } from "./drawing-components";
import { z } from "zod";
import {
	compositionModel,
	compositionViewRegistry,
	expression,
} from "./composition-contracts";
import type { ImageWorkspaceResource } from "./image-components";
export type { ImageWorkspaceResource } from "./image-components";
import type { RecordsResource } from "./records-components";
import type { MusicResource, GenerationResource } from "./media-contracts";
import type { UiStudioResource } from "./ui-studio-contracts";
import type {
	SettingsSectionResource,
	SettingsNavigationResource,
	SettingsChangesResource,
	SubtitlePreviewResource,
} from "./settings-contracts";
export type { MusicResource, GenerationResource } from "./media-contracts";

const title = z.string().max(480).optional();
const emphases = ["normal", "strong", "muted"] as const;
const layoutGaps = ["compact", "normal", "relaxed"] as const;
const layoutWidths = ["narrow", "normal", "wide"] as const;
/** Nested layouts: root included, at most this deep and this many views per definition. */
const maxLayoutDepth = 6;
const maxDefinitionViews = 240;
const source = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const field = z
	.strictObject({
		id: source,
		label: z.string().min(1).max(120),
		type: z.enum([
			"text",
			"textarea",
			"number",
			"select",
			"radio",
			"checkbox",
			"boolean",
		]),
		required: z.boolean().optional(),
		options: z.array(z.string().min(1).max(120)).min(1).max(128).optional(),
		optionLabels: z.record(z.string(), z.string().min(1).max(200)).optional(),
	})
	.superRefine((f, ctx) => {
		if (["select", "radio", "checkbox"].includes(f.type) && !f.options)
			ctx.addIssue({ code: "custom", message: "選択肢が必要です" });
	});
const question = z.strictObject({
	prompt: z.string().min(1).max(500),
	options: z.array(z.string().min(1).max(120)).min(1).max(8).optional(),
});
const musicChoices = z.array(z.string().min(1).max(80)).min(1).max(80);
const imageChoices = z.array(z.string().min(1).max(80)).min(1).max(80);
const imageCreationOptions = z.strictObject({
	styleGroups: z
		.array(
			z.strictObject({
				label: z.string().min(1).max(80),
				options: imageChoices,
			}),
		)
		.min(1)
		.max(12),
	moods: imageChoices,
	compositions: imageChoices,
	lighting: imageChoices,
	defaults: z.strictObject({
		width: z.number().int().min(100).max(1280),
		height: z.number().int().min(100).max(1280),
		format: z.enum(["png", "webp"]),
		seed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
	}),
});
const musicCreationOptions = z
	.strictObject({
		genreGroups: z
			.array(
				z.strictObject({
					label: z.string().min(1).max(80),
					options: musicChoices,
				}),
			)
			.min(1)
			.max(12),
		moods: musicChoices,
		instruments: musicChoices,
		tempos: musicChoices,
		durations: z.array(z.number().int().min(1).max(600)).min(1).max(20),
		vocalists: musicChoices,
		ranges: musicChoices,
		voiceQualities: musicChoices,
		singingStyles: musicChoices,
		languages: musicChoices,
		defaults: z.strictObject({
			tempo: z.string(),
			duration: z.number().int(),
			vocalist: z.string(),
			range: z.string(),
			singingStyle: z.string(),
			language: z.string(),
		}),
	})
	.superRefine((value, ctx) => {
		const checks = [
			[value.defaults.tempo, value.tempos],
			[value.defaults.duration, value.durations],
			[value.defaults.vocalist, value.vocalists],
			[value.defaults.range, value.ranges],
			[value.defaults.singingStyle, value.singingStyles],
			[value.defaults.language, value.languages],
		] as const;
		for (const [selected, options] of checks)
			if (!(options as readonly (string | number)[]).includes(selected))
				ctx.addIssue({ code: "custom", message: "unknown music default" });
	});
export const viewRegistry = {
	...compositionViewRegistry,
	"text-block": {
		name: "TextBlock",
		label: "見出しと説明文",
		schema: z.strictObject({
			view: z.literal("text-block"),
			source: z.never().optional(),
			title: z.string().min(1).max(120),
			body: z.string().max(2000).optional(),
			emphasis: z.enum(emphases).optional(),
		}),
	},
	"info-card": {
		name: "InfoCard",
		label: "情報カード",
		schema: z.strictObject({
			view: z.literal("info-card"),
			source: z.never().optional(),
			title: z.string().min(1).max(120),
			body: z.string().max(1000),
		}),
	},
	"ui-studio": {
		name: "UiStudio",
		label: "UI制作",
		schema: z.strictObject({ view: z.literal("ui-studio"), source, title }),
	},
	"ocr-media": {
		name: "OcrMedia",
		label: "OCRの元資料",
		schema: z.strictObject({ view: z.literal("ocr-media"), source, title }),
	},
	"ocr-panel": {
		name: "OcrPanel",
		label: "OCR結果と入力",
		schema: z.strictObject({ view: z.literal("ocr-panel"), source, title }),
	},
	"object-recognition-workspace": {
		name: "ObjectRecognitionWorkspace",
		label: "物体検出とカメラ入力",
		schema: z.strictObject({
			view: z.literal("object-recognition-workspace"),
			source,
			title,
		}),
	},
	"terminal-workspace": {
		name: "TerminalWorkspace",
		label: "ターミナル",
		schema: z.strictObject({
			view: z.literal("terminal-workspace"),
			source,
			title,
		}),
	},
	"kanban-board": {
		name: "KanbanBoard",
		label: "タスクボード",
		schema: z.strictObject({
			view: z.literal("kanban-board"),
			source,
			title,
		}),
	},
	"activity-timeline": {
		name: "ActivityTimeline",
		label: "活動の記録",
		schema: z.strictObject({
			view: z.literal("activity-timeline"),
			source,
			title,
		}),
	},
	"drawing-workspace": {
		name: "DrawingWorkspace",
		label: "図を描く・編集する",
		schema: z.strictObject({
			view: z.literal("drawing-workspace"),
			source,
			title,
		}),
	},
	"image-workspace": {
		name: "ImageWorkspace",
		label: "画像制作と一覧",
		schema: z.strictObject({
			view: z.literal("image-workspace"),
			source,
			title,
			presentation: z.enum(["embedded", "fullscreen"]).optional(),
			creationOptions: imageCreationOptions.optional(),
		}),
	},
	"image-creation-form": {
		name: "ImageCreationForm",
		label: "選択式画像プロンプト作成",
		schema: z.strictObject({
			view: z.literal("image-creation-form"),
			source,
			title,
		}),
	},
	"image-preview": {
		name: "ImagePreview",
		label: "画像プレビューと取得",
		schema: z.strictObject({ view: z.literal("image-preview"), source, title }),
	},
	"image-gallery": {
		name: "ImageGallery",
		label: "保存画像一覧",
		schema: z.strictObject({ view: z.literal("image-gallery"), source, title }),
	},
	"records-workspace": {
		name: "RecordsWorkspace",
		label: "記録の閲覧と管理",
		schema: z.strictObject({
			view: z.literal("records-workspace"),
			source,
			title,
		}),
	},
	"collection-workspace": {
		name: "CollectionWorkspace",
		label: "登録された一覧の表示と編集",
		schema: z
			.strictObject({
				view: z.literal("collection-workspace"),
				source,
				title,
				presentation: z
					.enum(["table", "catalog", "summary", "indicator"])
					.optional(),
				indicator: z
					.strictObject({
						key: z.string().min(1).max(64),
						activeValue: z.string().max(80),
					})
					.optional(),
				tableColumns: z
					.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/))
					.min(1)
					.max(32)
					.optional(),
				detailMode: z.enum(["inline", "modal"]).optional(),
				selectionField: z
					.string()
					.regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)
					.optional(),
			})
			.refine(
				(request) =>
					!request.selectionField || request.presentation === "catalog",
				{
					message: "selectionField requires catalog presentation",
				},
			),
	},
	"service-test-workspace": {
		name: "ServiceTestWorkspace",
		label: "サービスの動作確認",
		schema: z.strictObject({
			view: z.literal("service-test-workspace"),
			source: source.optional(),
			title,
			statusSource: source,
			catalogSource: source,
			runsSource: source,
			healthSource: source,
		}),
	},
	"avatar-motion-lab": {
		name: "AvatarMotionLab",
		label: "光の精霊の動作試写",
		// The host renders the 3D preview; nothing here is read from or written to a source.
		schema: z.strictObject({
			view: z.literal("avatar-motion-lab"),
			// z.undefined() cannot be expressed in JSON Schema and would break the whole library.
			source: z.never().optional(),
			title,
		}),
	},
	"subtitle-preview": {
		name: "SubtitlePreview",
		label: "字幕の見本",
		schema: z.strictObject({
			view: z.literal("subtitle-preview"),
			source,
			title,
		}),
	},
	"google-accounts": {
		name: "GoogleAccountsView",
		label: "Google連携",
		schema: z.strictObject({
			view: z.literal("google-accounts"),
			source,
			title,
		}),
	},
	"settings-section": {
		name: "SettingsSectionView",
		label: "設定の編集",
		schema: z.strictObject({
			view: z.literal("settings-section"),
			source,
			title,
			presentation: z.enum(["default", "card"]).optional(),
		}),
	},
	"settings-navigation": {
		name: "SettingsNavigationView",
		label: "設定の入口",
		schema: z.strictObject({
			view: z.literal("settings-navigation"),
			source,
			title,
		}),
	},
	"settings-changes": {
		name: "SettingsChangesView",
		label: "設定の変更一覧",
		schema: z.strictObject({
			view: z.literal("settings-changes"),
			source,
			title,
		}),
	},
	"timer-workspace": {
		name: "TimerWorkspace",
		label: "タイマーの設定と円形時計",
		schema: z.strictObject({
			view: z.literal("timer-workspace"),
			source,
			title,
		}),
	},
	"music-workspace": {
		name: "MusicWorkspace",
		label: "Visualizer・楽曲一覧・共通プレイヤー",
		schema: z.strictObject({
			view: z.literal("music-workspace"),
			source,
			title,
			creationOptions: musicCreationOptions.optional(),
		}),
	},
	"music-library": {
		name: "MusicLibraryControls",
		label: "楽曲ライブラリ検索",
		schema: z.strictObject({ view: z.literal("music-library"), source, title }),
	},
	"music-player": {
		name: "MusicPlayer",
		label: "音楽プレイヤー",
		schema: z.strictObject({ view: z.literal("music-player"), source, title }),
	},
	playlist: {
		name: "Playlist",
		label: "プレイリスト",
		schema: z.strictObject({ view: z.literal("playlist"), source, title }),
	},
	"generation-status": {
		name: "GenerationStatus",
		label: "生成の状態",
		schema: z.strictObject({
			view: z.literal("generation-status"),
			source,
			title,
		}),
	},
	components: {
		name: "Components",
		label: "基本コンポーネント",
		schema: z.strictObject({ view: z.literal("components"), source, title }),
	},
	"generated-image": {
		name: "GeneratedImage",
		label: "画像の額縁",
		schema: z.strictObject({
			view: z.literal("generated-image"),
			source,
			title,
		}),
	},
	question: {
		name: "Question",
		label: "質問と回答",
		schema: z
			.strictObject({
				view: z.literal("question"),
				source: source.optional(),
				title,
				question: question.optional(),
			})
			.superRefine((r, ctx) => {
				if (!r.source && !r.question)
					ctx.addIssue({
						code: "custom",
						message: "source または question が必要です",
					});
				if (r.source && r.question)
					ctx.addIssue({
						code: "custom",
						message: "source と question は併用できません",
					});
			}),
	},
	form: {
		name: "SmallForm",
		label: "小さなフォーム",
		schema: z
			.strictObject({
				view: z.literal("form"),
				source: source.optional(),
				title,
				fields: z.array(field).min(1).max(8).optional(),
			})
			.superRefine((r, ctx) => {
				if ((!r.source && !r.fields) || (r.source && r.fields))
					ctx.addIssue({
						code: "custom",
						message: "source または fields の一方を指定してください",
					});
				if (
					r.fields &&
					new Set(r.fields.map((f) => f.id)).size !== r.fields.length
				)
					ctx.addIssue({ code: "custom", message: "項目IDが重複しています" });
			}),
	},
	memory: {
		name: "MemoryReview",
		label: "メモリーの整理",
		schema: z.strictObject({ view: z.literal("memory"), source, title }),
	},
	settings: {
		name: "SettingsForm",
		label: "表示と音声の設定",
		schema: z.strictObject({ view: z.literal("settings"), source, title }),
	},
} as const;
export type View = keyof typeof viewRegistry;
export type ArtifactRequest = {
	[K in View]: z.infer<(typeof viewRegistry)[K]["schema"]>;
}[View];
export type Field = z.infer<typeof field>;
export type QuestionData = z.infer<typeof question>;
export const maxDefinitionBytes = 98_304;
export function parseRequest(value: unknown): ArtifactRequest {
	if (
		!value ||
		typeof value !== "object" ||
		!("view" in value) ||
		typeof value.view !== "string" ||
		!Object.hasOwn(viewRegistry, value.view)
	)
		throw new Error("未登録の表示です");
	return viewRegistry[value.view as View].schema.parse(value);
}
const layoutShape = z.strictObject({
	view: z.literal("layout"),
	direction: z
		.enum(["stack", "grid", "tabs", "form-preview", "slides"])
		.default("stack"),
	/** The composition's shared state; the outermost layout only (`validateComposition`). */
	model: compositionModel.optional(),
	/** Shows the children only while this expression is true. */
	when: expression.optional(),
	appearance: z.enum(["clean", "warm", "elegant", "friendly"]).optional(),
	gap: z.enum(layoutGaps).optional(),
	width: z.enum(layoutWidths).optional(),
	title,
	draftSource: source.optional(),
	headerChildren: z.array(z.number().int().min(0).max(11)).max(12).optional(),
	headerLayout: z.enum(["stack", "inline"]).optional(),
	tabs: z
		.array(
			z.strictObject({
				label: z.string().min(1).max(80),
				children: z.array(z.number().int().min(0).max(11)).min(1),
				/** `form-preview` shows the tab's subtitle preview inside its settings section. */
				arrangement: z.enum(["form-preview"]).optional(),
			}),
		)
		.min(1)
		.max(12)
		.optional(),
});
export type Layout = z.infer<typeof layoutShape> & {
	children: Array<ArtifactRequest | Layout>;
};
/** Depth (this node = 1) and number of views of a definition subtree, layouts included. */
function layoutExtent(node: ArtifactRequest | Layout): {
	depth: number;
	views: number;
} {
	if (node.view !== "layout") return { depth: 1, views: 1 };
	let depth = 0;
	let views = 1;
	for (const child of node.children) {
		const extent = layoutExtent(child);
		depth = Math.max(depth, extent.depth);
		views += extent.views;
	}
	return { depth: depth + 1, views };
}
function refineLayout(value: Layout, context: z.RefinementCtx) {
	const extent = layoutExtent(value);
	if (extent.depth > maxLayoutDepth)
		context.addIssue({
			code: "custom",
			message: `layout nesting is limited to ${maxLayoutDepth} levels`,
		});
	if (extent.views > maxDefinitionViews)
		context.addIssue({
			code: "custom",
			message: `a definition holds at most ${maxDefinitionViews} views`,
		});
	if (
		value.draftSource &&
		(value.direction !== "tabs" ||
			!value.children.some(
				(child) =>
					child.view === "settings-section" &&
					child.source === value.draftSource,
			))
	)
		context.addIssue({
			code: "custom",
			message: "draftSource must name a settings section in tabs",
		});
	if (
		value.direction === "form-preview" &&
		(value.children.length !== 2 ||
			value.children[0]?.view !== "settings-section" ||
			value.children[1]?.view !== "subtitle-preview")
	)
		context.addIssue({
			code: "custom",
			message: "form-preview requires a settings section and subtitle preview",
		});
	for (const tab of value.tabs ?? [])
		if (
			tab.arrangement === "form-preview" &&
			(tab.children.length !== 2 ||
				value.children[tab.children[0]!]?.view !== "settings-section" ||
				value.children[tab.children[1]!]?.view !== "subtitle-preview")
		)
			context.addIssue({
				code: "custom",
				message:
					"form-preview requires a settings section and subtitle preview",
			});
	if (value.headerChildren && value.direction !== "tabs")
		context.addIssue({
			code: "custom",
			message: "headerChildren requires tabs",
		});
	if (value.headerChildren && !value.tabs)
		context.addIssue({
			code: "custom",
			message: "headerChildren requires explicit tabs",
		});
	if (!value.tabs) return;
	const indexes = [
		...(value.headerChildren ?? []),
		...value.tabs.flatMap((tab) => tab.children),
	];
	if (
		value.direction !== "tabs" ||
		indexes.length !== value.children.length ||
		new Set(indexes).size !== value.children.length ||
		indexes.some((index) => index >= value.children.length)
	)
		context.addIssue({
			code: "custom",
			message: "tabs must contain each child exactly once",
		});
}
export const layoutSchema: z.ZodType<Layout> = z.lazy(() =>
	layoutShape
		.extend({
			children: z
				.array(
					z.union([
						...Object.values(viewRegistry).map((v) => v.schema),
						layoutSchema,
					]),
				)
				.min(1)
				.max(48),
		})
		.superRefine(refineLayout),
);
export type ArtifactDefinition = ArtifactRequest | Layout;
export function parseDocument(value: unknown): ArtifactDefinition {
	if (
		value &&
		typeof value === "object" &&
		"view" in value &&
		value.view === "layout"
	)
		return layoutSchema.parse(value);
	return parseRequest(value);
}
export function definitionRequests(
	definition: ArtifactDefinition,
): ArtifactRequest[] {
	return definition.view === "layout"
		? definition.children.flatMap(definitionRequests)
		: [definition];
}
export function definitionName(definition: ArtifactDefinition): string {
	return definition.view === "layout"
		? "Composition"
		: viewRegistry[definition.view].name;
}
export function parseDefinition(input: string): ArtifactDefinition {
	if (new TextEncoder().encode(input).length > maxDefinitionBytes)
		throw new Error("定義が大きすぎます（96KBまで）");
	return parseDocument(JSON.parse(input));
}

const SAFE_DATA_IMAGE = /^data:image\/(?:png|jpeg|webp|svg\+xml);/i;
/** Only https:, blob: and a short list of raster/SVG data: URLs may be shown as an image. */
export function isSafeImageUrl(value: string): boolean {
	return /^(?:https:|blob:)/i.test(value) || SAFE_DATA_IMAGE.test(value);
}
export const imageUrlSchema = z.string().refine(isSafeImageUrl, {
	message: "unsafe_image_url",
});
export type ImageResource = {
	kind: "generated-image";
	revision: number;
	status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
	url?: string;
	mimeType?: string;
	alt: string;
};
const IMAGE_EXTENSIONS: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/jpg": "jpg",
	"image/webp": "webp",
	"image/svg+xml": "svg",
};
/** Download name derived from the mime type, else the data: header or URL extension. */
export function imageDownloadName(image: {
	url?: string;
	mimeType?: string;
}): string {
	const mime = (
		image.mimeType ?? /^data:([^;,]+)/i.exec(image.url ?? "")?.[1]
	)?.toLowerCase();
	let ext = mime ? IMAGE_EXTENSIONS[mime] : undefined;
	if (!ext && image.url && !image.url.startsWith("data:")) {
		const path = image.url.split(/[?#]/)[0] ?? "";
		const found = /\.(png|jpe?g|webp|svg)$/i.exec(path)?.[1]?.toLowerCase();
		ext = found === "jpeg" ? "jpg" : found;
	}
	return ext ? `generated-image.${ext}` : "generated-image";
}
export type QuestionResource = {
	kind: "question";
	revision: number;
	status: "open" | "answered" | "expired";
	question: QuestionData;
	answer?: string;
};
export type FormResource = {
	kind: "form";
	revision: number;
	submitLabel?: string;
	fields: Field[];
	defaults: Record<string, string | boolean>;
	submitted?: Record<string, string | boolean>;
};
export type MemoryResource = {
	kind: "memory";
	revision: number;
	entries: { id: string; text: string; selected: boolean }[];
};
export type SettingsResource = {
	kind: "settings";
	revision: number;
	theme: "light" | "dark";
	autoSpeak: boolean;
	volume: number;
};
export type Resource =
	| GoogleAccountsResource
	| ObjectRecognitionResource
	| TerminalsResource
	| KanbanResource
	| ActivityResource
	| ImageWorkspaceResource
	| RecordsResource
	| SubtitlePreviewResource
	| SettingsSectionResource
	| SettingsNavigationResource
	| SettingsChangesResource
	| {
			kind: "timer-workspace";
			revision: number;
			state:
				| "setup"
				| "active"
				| "paused"
				| "confirming"
				| "elapsed"
				| "cancelled";
			durationSeconds?: number;
			remainingSeconds?: number;
			title?: string;
			dueAt?: string;
			finishLabel?: string;
			durationLabel?: string;
			canCreate?: boolean;
			mode?: "timer" | "stopwatch";
			stopwatch?: { elapsedMs: number; running: boolean };
	  }
	| OcrResource
	| DrawingResource
	| MusicResource
	| GenerationResource
	| ImageResource
	| QuestionResource
	| CollectionResource
	| FormResource
	| UiStudioResource
	| MemoryResource
	| SettingsResource
	| { kind: "components"; revision: number; example?: string };
export type Snapshot = Readonly<Record<string, Resource>>;
export type { ArtifactEvent } from "./event-contracts";
export type { Receipt } from "./receipt-contracts";

export type { ActivityResource } from "./activity-components";
