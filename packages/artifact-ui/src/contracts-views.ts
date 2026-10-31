import { z } from "zod";
import { browserViews } from "./browser-contracts";
import { compositionViewRegistry } from "./composition-contracts";
import { computeViewRegistry } from "./compute-contracts";

export const title = z.string().max(480).optional();
const emphases = ["normal", "strong", "muted"] as const;
export const source = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const field = z
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
export const question = z.strictObject({
	prompt: z.string().min(1).max(500),
	options: z.array(z.string().min(1).max(120)).min(1).max(8).optional(),
});
const musicChoices = z.array(z.string().min(1).max(80)).min(1).max(80);
const imageChoices = z.array(z.string().min(1).max(80)).min(1).max(80);
const imageCreationOptions = z.strictObject({
	models: z
		.array(
			z.strictObject({
				value: z.string().min(1).max(200),
				label: z.string().min(1).max(80),
				description: z.string().max(500).optional(),
			}),
		)
		.min(1)
		.max(20)
		.optional(),
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
		model: z.string().min(1).max(200).optional(),
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
	"usage-dashboard": {
		name: "UsageDashboard",
		label: "利用状況の集計",
		schema: z.strictObject({
			view: z.literal("usage-dashboard"),
			source,
			title,
		}),
	},
	"external-app-launcher": {
		name: "ExternalAppLauncher",
		label: "外部アプリを開く",
		schema: z.strictObject({
			view: z.literal("external-app-launcher"),
			source,
			title,
		}),
	},
	...computeViewRegistry,
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
	"pipeline-studio": {
		name: "PipelineStudio",
		label: "パイプライン制作",
		schema: z.strictObject({
			view: z.literal("pipeline-studio"),
			source,
			title,
		}),
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
	"work-menu": {
		name: "WorkMenu",
		label: "仕事一覧",
		schema: z.strictObject({ view: z.literal("work-menu"), source, title }),
	},
	"work-result": {
		name: "WorkResult",
		label: "仕事の結果",
		schema: z.strictObject({ view: z.literal("work-result"), source, title }),
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
	"todo-workspace": {
		name: "TodoWorkspace",
		label: "会話の仕事と報告の一覧",
		schema: z.strictObject({
			view: z.literal("todo-workspace"),
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
	"model3d-workspace": {
		name: "Model3dWorkspace",
		label: "3Dモデルの生成・検索・表示",
		schema: z.strictObject({
			view: z.literal("model3d-workspace"),
			source,
			title,
		}),
	},
	...browserViews(source, title),
	"subtitle-preview": {
		name: "SubtitlePreview",
		label: "字幕の見本",
		schema: z.strictObject({
			view: z.literal("subtitle-preview"),
			source,
			title,
		}),
	},
	"dots-messaging": {
		name: "DotsMessagingView",
		label: "dots メッセージ",
		schema: z.strictObject({
			view: z.literal("dots-messaging"),
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
			footer: z.boolean().optional(),
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
