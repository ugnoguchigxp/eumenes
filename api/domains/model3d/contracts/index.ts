import { z } from "zod";

/** LARM's id grammar for jobs, assets and image artifacts. */
export const model3dId = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
export const model3dTitle = z.string().trim().min(1).max(80);
export const model3dTag = z.string().trim().min(1).max(24);
export const model3dTags = z.array(model3dTag).max(8);

/** What the user asked to turn into 3D: a prompt drawn into a source image first, or a saved LARM image. */
export const model3dSource = z.discriminatedUnion("type", [
	z.strictObject({
		type: z.literal("prompt"),
		prompt: z.string().trim().min(1).max(2000),
	}),
	z.strictObject({ type: z.literal("image-artifact"), id: model3dId }),
]);
export type Model3dSource = z.infer<typeof model3dSource>;

export const model3dCreate = z.strictObject({
	requestId: z.uuid(),
	title: model3dTitle,
	tags: model3dTags,
	source: model3dSource,
});

export const generationStates = [
	"submitting",
	"queued",
	"running",
	"completed",
	"failed",
	"cancelled",
] as const;
export type GenerationState = (typeof generationStates)[number];

export const model3dGeneration = z.object({
	id: z.uuid(),
	title: z.string(),
	tags: z.array(z.string()),
	source: model3dSource,
	state: z.enum(generationStates),
	stage: z.string().nullable(),
	stageLabel: z.string(),
	assetId: z.string().nullable(),
	deleted: z.boolean(),
	warnings: z.array(z.string()),
	errorCode: z.string().nullable(),
	errorLabel: z.string().nullable(),
	origin: z.enum(["conversation", "screen", "task"]),
	createdAt: z.number(),
	updatedAt: z.number(),
	revision: z.number().int(),
});
export type Model3dGeneration = z.infer<typeof model3dGeneration>;

export type Model3dAsset = {
	id: string;
	title: string;
	tags: string[];
	createdAt: string;
	prompt: string | null;
	warnings: string[];
	hasSource: boolean;
};

export type Model3dFocus =
	| { seq: number; kind: "asset"; assetId: string }
	| { seq: number; kind: "search"; query: string; tags: string[] }
	| { seq: number; kind: "generation"; generationId: string };

/** The labels LARM publishes for its stages; stage and status are separate fields. */
const stageLabels: Record<string, string> = {
	queued: "受付済み・待機中",
	image: "元画像を生成中",
	waiting_gpu: "生成枠・メモリの空きを待機中",
	background: "背景を除去中",
	mesh: "3Dモデルを生成中",
	validating: "3Dデータを検証中",
	stopping: "生成エンジンを停止中",
	completed: "生成完了",
	failed: "生成失敗",
	cancelled: "生成を取消済み",
	deleted: "完成品は削除済み",
};
export function stageLabel(
	state: GenerationState,
	stage: string | null,
	deleted: boolean,
) {
	if (deleted) return stageLabels.deleted!;
	if (state === "submitting") return "LARMへ送信中";
	if (state === "completed" || state === "failed" || state === "cancelled")
		return stageLabels[state]!;
	return (stage && stageLabels[stage]) || "処理中";
}

const errorLabels: Record<string, string> = {
	model3d_service_unavailable: "LARMに3D生成サービスが見つかりません",
	model3d_image_service_unavailable:
		"元画像を作る画像生成サービスが見つかりません",
	model3d_larm_unconfigured: "LARMの接続先が設定されていません",
	model3d_service_invalid: "LARMの3D生成サービスの掲載内容を確認できません",
	model3d_unreachable: "LARMに接続できません",
	model3d_asset_missing: "完了しましたが、LARMが完成品を返しませんでした",
	model3d_invalid_request: "入力内容をLARMが受け付けませんでした",
	model3d_auth_failed: "LARMの接続先とControl認証を確認してください",
	model3d_idempotency_conflict:
		"同じ依頼に別の内容が送られました。元の依頼を確認してください",
	model3d_unavailable: "LARMの3D生成が利用できません",
	model3d_storage_full: "LARMの保存容量が不足しています",
	model3d_interrupted: "生成が中断されました（自動では作り直しません）",
	model3d_worker_stop_failed:
		"LARM側で生成エンジンの停止確認と結果の回復が必要です",
	model3d_generation_failed: "LARMで生成に失敗しました",
	model3d_submission_unconfirmed:
		"LARMが受け付けたか確認できません。状態を再確認してください",
	model3d_status_unconfirmed:
		"生成の状態を確認できません。状態を再確認してください",
	model3d_timeout: "待ち時間の上限を超えました。状態を再確認してください",
	model3d_cancel_unconfirmed: "取消を確認できませんでした",
	model3d_not_found: "LARMに該当する生成が見つかりません",
};
export const errorLabel = (code: string | null) =>
	code ? (errorLabels[code] ?? "生成に失敗しました") : null;

/** Everything the domain needs from LARM (implemented by the larm domain's mesh library). */
export interface Model3dLarm {
	discover(signal: AbortSignal): Promise<{
		mesh: { model: string; path: string } | null;
		image: { model: string; path: string } | null;
	}>;
	submit(
		path: string,
		body: {
			model: string;
			source:
				| { type: "prompt"; prompt: string; imageModel: string }
				| { type: "image-artifact"; id: string };
			title: string;
			tags: string[];
			resolution: 512;
			seed: number;
		},
		idempotencyKey: string,
		signal: AbortSignal,
	): Promise<string>;
	job(
		path: string,
		jobId: string,
		signal: AbortSignal,
	): Promise<{
		status: "queued" | "running" | "completed" | "failed" | "cancelled";
		stage?: string | null;
		deleted?: boolean;
		assetId?: string | null;
		asset?: { id: string; warnings?: string[] } | null;
		error?: string | null;
		errorCode?: string | null;
		reason?: string | null;
		warnings?: string[];
	}>;
	cancel(path: string, jobId: string, signal: AbortSignal): Promise<void>;
	assets(
		query: {
			q?: string;
			tags?: string[];
			sort?: "createdAt" | "relevance";
			order?: "asc" | "desc";
			limit?: number;
			cursor?: string;
		},
		signal: AbortSignal,
	): Promise<{
		assets: Model3dAsset[];
		total: number;
		nextCursor: string | null;
	}>;
	asset(id: string, signal: AbortSignal): Promise<Model3dAsset>;
	update(
		id: string,
		patch: { title?: string; tags?: string[] },
		signal: AbortSignal,
	): Promise<Model3dAsset>;
	remove(id: string, signal: AbortSignal): Promise<void>;
	content(
		id: string,
		signal: AbortSignal,
	): Promise<{ bytes: Uint8Array; mime: string }>;
}

/** A LARM refusal as the larm library reports it (structural: the domain does not import larm). */
export type LarmRefusal = Error & {
	status: number;
	reason: string | null;
	retryAfterMs: number | null;
};
export const isLarmRefusal = (e: unknown): e is LarmRefusal =>
	e instanceof Error &&
	typeof (e as Partial<LarmRefusal>).status === "number" &&
	/^larm_http_\d+$/.test(e.message);

/** A finished generation reported into the conversation that asked for it. */
export type Model3dCompletion = {
	id: string;
	conversationId: string;
	message: string;
	/** ISO time, as conversation messages carry it. */
	at: string;
};
