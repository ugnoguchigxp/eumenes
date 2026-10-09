import { z } from "zod";
import type { TestKind, TestHealth } from "../../larm";
export type { TestKind, TestHealth } from "../../larm";
export interface ServiceTarget {
	id: string;
	name: string;
	model: string;
	capability: string;
	protocol: string;
	kind: TestKind;
	source: "larm" | "cloud";
	onDemand: boolean;
	primary: boolean;
	testable: boolean;
	reason?: string;
}
export interface ServiceCatalog {
	targets: ServiceTarget[];
	errors: string[];
	discoveredAt: number | null;
	revision: number;
	stale: boolean;
}
export const inputSchema = z
	.object({
		text: z
			.string()
			.trim()
			.min(1)
			.max(4096)
			.default("こんにちは。短い挨拶をお願いします。"),
		comparison: z.string().trim().max(4096).optional(),
		voice: z.string().trim().max(128).optional(),
		width: z
			.union([z.literal(512), z.literal(768), z.literal(1024)])
			.optional(),
		height: z
			.union([z.literal(512), z.literal(768), z.literal(1024)])
			.optional(),
		format: z.enum(["png", "webp"]).optional(),
		durationSeconds: z.number().int().min(1).max(30).optional(),
		uploadId: z.string().uuid().optional(),
	})
	.strict();
export const startSchema = z
	.object({
		targetId: z.string().min(1).max(150),
		revision: z.number().int().nonnegative(),
		requestKey: z.string().uuid(),
		input: inputSchema,
	})
	.strict();
export type StartTest = z.infer<typeof startSchema>;
export interface HealthRow extends TestHealth {
	targetId: string;
	name: string;
	model: string;
}
export interface ServiceRun {
	id: string;
	targetId: string;
	model: string;
	actualModel?: string;
	kind: TestKind | "diagnostics";
	status:
		| "running"
		| "succeeded"
		| "failed"
		| "cancelled"
		| "unknown"
		| "interrupted"
		| "result-unavailable";
	phase: string;
	created: number;
	ended?: number;
	revision: number;
	error?: string;
	progress?: number;
	jobId?: string;
	text?: string;
	mime?: string;
	previewAvailable?: boolean;
	retryArtifact?: boolean;
	health?: HealthRow[];
	controlHealthy?: boolean;
}
export const kindLabels: Record<TestKind, string> = {
	llm: "会話",
	asr: "音声認識",
	tts: "音声合成",
	embedding: "埋め込み",
	decision: "判断",
	image: "画像生成",
	music: "楽曲生成",
	unsupported: "未対応サービス",
};
export const healthLabels: Record<TestHealth["state"], string> = {
	healthy: "正常",
	busy: "混雑",
	unhealthy: "異常",
	"on-demand": "実行時に起動",
	unknown: "確認できません",
	unsupported: "Health未対応",
};
export const phaseLabels: Record<string, string> = {
	accepted: "受付済み",
	preparing: "接続準備中",
	running: "実行中",
	generating: "起動・生成を待っています",
	queued: "順番待ち",
	loading: "モデル起動中",
	encoding: "音声を仕上げています",
	"fetching-result": "結果を取得中",
	succeeded: "成功",
	failed: "失敗",
	cancelled: "中止",
	cancelling: "停止を確認中",
	unknown: "結果不明",
	interrupted: "中断",
	"result-unavailable": "生成済み・結果取得に失敗",
	diagnosing: "Healthを確認中",
};
export function testErrorLabel(code: string) {
	const labels: Record<string, string> = {
		stale_catalog: "一覧が更新されました。一覧を更新してから試してください。",
		invalid_stale_settings: "設定が変わりました。一覧を更新してください。",
		invalid_test_busy: "別の確認が実行中です。完了を待ってください。",
		invalid_test_target: "このサービスはまだ試用に対応していません。",
		invalid_upload: "音声ファイルの有効期限または形式を確認してください。",
		invalid_permission: "接続と送信許可を確認してください。",
		larm_unconfigured: "LARMの認証設定がありません。",
		larm_http_401: "認証に失敗しました。",
		larm_http_403: "利用が許可されていません。",
		larm_http_409: "ほかの処理が使用中です。時間をおいて試してください。",
		larm_http_503: "サービスが準備できていません。",
		network_unavailable: "接続できませんでした。",
		generation_unknown:
			"生成が続いている可能性があります。自動再送は行いません。",
		cancel_unconfirmed:
			"停止を確認できませんでした。生成が続いている可能性があります。",
		health_api_unavailable:
			"専用Health APIがないため、生成の成否は簡単テストで確認してください。",
		semantic_health_ok: "LARMのHealth確認に成功しました。",
		unsupported_protocol: "対応する実行方法がありません。",
		cloud_health_unsupported:
			"専用Health APIは未対応です。簡単テストで動作を確認できます。",
		provider_not_ready: "プロバイダが準備できていません。",
		provider_busy: "プロバイダが混雑しています。",
		deadline_exceeded: "確認の時間制限を超えました。",
		preview_expired: "プレビューの保持期限が過ぎました。",
		invalid_request_key: "同じ受付キーが別の入力に使われています。",
	};
	return (
		labels[code] ??
		"確認に失敗しました。接続先とサービスの状態を確認してください。"
	);
}
