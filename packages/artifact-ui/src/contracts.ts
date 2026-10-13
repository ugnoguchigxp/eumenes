import type { ObjectRecognitionResource } from "./object-recognition-components";
export type { ObjectRecognitionResource } from "./object-recognition-components";
import type { DrawingResource } from "./drawing-components";
import { z } from "zod";
import type { ImageWorkspaceResource } from "./image-components";
export type { ImageWorkspaceResource } from "./image-components";
import type { RecordsResource } from "./records-components";
import type { MusicResource, GenerationResource } from "./media-contracts";
import type {
	SettingsSectionResource,
	SettingsNavigationResource,
	SettingsChangesResource,
	SubtitlePreviewResource,
} from "./settings-contracts";
export type { MusicResource, GenerationResource } from "./media-contracts";

const title = z.string().max(120).optional();
const source = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const field = z
	.strictObject({
		id: source,
		label: z.string().min(1).max(120),
		type: z.enum(["text", "textarea", "number", "select", "boolean"]),
		required: z.boolean().optional(),
		options: z.array(z.string().min(1).max(120)).min(1).max(8).optional(),
	})
	.superRefine((f, ctx) => {
		if (f.type === "select" && !f.options)
			ctx.addIssue({ code: "custom", message: "選択肢が必要です" });
	});
const question = z.strictObject({
	prompt: z.string().min(1).max(500),
	options: z.array(z.string().min(1).max(120)).min(1).max(8).optional(),
});
export const viewRegistry = {
	"object-recognition-workspace": {
		name: "ObjectRecognitionWorkspace",
		label: "物体検出とカメラ入力",
		schema: z.strictObject({
			view: z.literal("object-recognition-workspace"),
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
	"subtitle-preview": {
		name: "SubtitlePreview",
		label: "字幕の見本",
		schema: z.strictObject({
			view: z.literal("subtitle-preview"),
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
export const maxDefinitionBytes = 16_384;
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
export const layoutSchema = z.strictObject({
	view: z.literal("layout"),
	direction: z.enum(["stack", "grid"]).default("stack"),
	title,
	children: z
		.array(z.union(Object.values(viewRegistry).map((v) => v.schema)))
		.min(1)
		.max(12),
});
export type ArtifactDefinition = ArtifactRequest | z.infer<typeof layoutSchema>;
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
	return definition.view === "layout" ? definition.children : [definition];
}
export function definitionName(definition: ArtifactDefinition): string {
	return definition.view === "layout"
		? "Composition"
		: viewRegistry[definition.view].name;
}
export function parseDefinition(input: string): ArtifactDefinition {
	if (new TextEncoder().encode(input).length > maxDefinitionBytes)
		throw new Error("定義が大きすぎます（16KBまで）");
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
	| ObjectRecognitionResource
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
	| DrawingResource
	| MusicResource
	| GenerationResource
	| ImageResource
	| QuestionResource
	| FormResource
	| MemoryResource
	| SettingsResource
	| { kind: "components"; revision: number; example?: string };
export type Snapshot = Readonly<Record<string, Resource>>;
export type ArtifactEvent = {
	id: string;
	source: string;
	revision: number;
	action:
		| "recognition-select"
		| "recognition-cancel"
		| "recognition-refresh"
		| "recognition-recheck"
		| "recognition-credential-source"
		| "recognition-remove"
		| "recognition-incorporate"
		| "drawing-new"
		| "drawing-open"
		| "drawing-refresh"
		| "image-close"
		| "image-delete"
		| "image-generate"
		| "image-cancel"
		| "image-refresh"
		| "image-select"
		| "records-refresh"
		| "records-query"
		| "records-procedure-state"
		| "records-procedure-delete"
		| "records-download"
		| "settings-edit"
		| "settings-action"
		| "settings-open"
		| "settings-review"
		| "settings-apply"
		| "settings-discard"
		| "timer-start"
		| "timer-cancel"
		| "timer-pause"
		| "timer-resume"
		| "timer-new"
		| "clock-mode"
		| "stopwatch-start"
		| "stopwatch-stop"
		| "stopwatch-reset"
		| "answer"
		| "submit"
		| "memory-correct"
		| "memory-select"
		| "settings-save"
		| "demo-click"
		| "music-select"
		| "music-generate"
		| "music-cancel"
		| "music-search"
		| "music-more"
		| "music-refresh"
		| "music-favorite"
		| "music-delete"
		| "generation-cancel"
		| "generation-retry";
	values: Record<string, string | boolean>;
};
/**
 * accepted/duplicate/conflict/rejected are final. pending (accepted for later settlement) and
 * indeterminate (the outcome is not known yet; the host reconciles the same operation) are
 * display states: neither is a confirmed success, and neither may be shown as a failure.
 */
export type Receipt = {
	status:
		| "accepted"
		| "duplicate"
		| "conflict"
		| "rejected"
		| "pending"
		| "indeterminate";
	message: string;
};
