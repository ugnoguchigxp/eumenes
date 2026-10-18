import type { EumenesClient } from "../../../client";
import { ApiError } from "../../../client/transport";
import type { ImageImportView } from "../../../api/domains/image/contracts";
import type { Receipt } from "@eumenes/artifact-ui/contracts";

export const imageUploadMessage = (
	code: string | undefined,
	status?: number,
	fallback = "アップロード結果を確認できません。受付番号を保ったまま再確認してください。",
) =>
	(
		({
			photos_session_changed:
				"Googleフォトの選択またはアカウントが変わりました。写真を選び直してください。",
			photos_session_expired:
				"Googleフォトの写真選択の期限が切れました。選び直してください。",
			photos_authorization_required:
				"Googleフォトの写真選択を許可してください。",
			photos_image_unsupported:
				"Googleフォトの写真はJPEG・PNG・WebPの静止画を選んでください。",
			photos_image_too_large: "Googleフォトの元画像が容量上限を超えています。",
			unauthorized: "LARMの認証に失敗しました。接続設定を確認してください。",
			forbidden: "この画像を取り込む権限がありません。",
			idempotency_conflict: "同じ受付番号に別の画像が指定されています。",
			image_too_large: "画像の容量または寸法が上限を超えています。",
			image_dimensions_exceeded: "元画像の寸法が安全上限を超えています。",
			unsupported_media_type: "対応していない画像形式です。",
			image_format_unsupported: "JPEG・PNG・WebPの静止画を選んでください。",
			image_mime_mismatch: "画像の形式とファイルの種類が一致しません。",
			invalid_image: "画像が壊れているため読み込めません。",
			image_invalid: "画像が壊れているため読み込めません。",
			import_busy: "受付が混み合っています。同じ受付番号で再確認してください。",
			image_import_busy:
				"受付が混み合っています。同じ受付番号で再確認してください。",
			import_unavailable: "画像取込を現在利用できません。",
			storage_full: "LARMの保存容量が不足しています。",
			image_import_storage_full: "LARMの保存容量が不足しています。",
			image_import_receipt_expired:
				"受付の照会期限が切れました。保存画像の一覧を確認してください。",
			image_import_artifact_deleted:
				"取り込んだ画像は削除済みです。再作成は行いません。",
			image_import_connection_changed:
				"LARMの接続先または認証が変わったため、この画像の再送を停止しました。",
		}) as Record<string, string>
	)[code ?? ""] ??
	(
		{
			401: "LARMの認証に失敗しました。",
			409: "受付番号が競合しています。",
			413: "画像の容量または寸法が上限を超えています。",
			415: "画像形式・MIME・アニメーションは受け付けられません。",
			400: "画像が壊れているか、内容が正しくありません。",
			429: "受付が混み合っています。同じ受付番号で再確認してください。",
			503: "画像取込を現在利用できません。",
			507: "LARMの保存容量が不足しています。",
		} as Record<number, string>
	)[status ?? 0] ??
	fallback;

export function waitForImagePoll(ms: number, signal: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		signal.throwIfAborted();
		const stop = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", stop);
			resolve();
		}, ms);
		signal.addEventListener("abort", stop, { once: true });
	});
}

export async function settleImageImport(
	client: EumenesClient,
	requestId: string,
	send: () => Promise<ImageImportView>,
	signal: AbortSignal,
): Promise<Receipt & { value?: string; canRetry?: boolean }> {
	let view: ImageImportView;
	try {
		view = await send();
	} catch (error) {
		signal.throwIfAborted();
		if (
			error instanceof ApiError &&
			([400, 413, 415].includes(error.status) ||
				[
					"photos_session_changed",
					"photos_session_expired",
					"photos_authorization_required",
					"photos_image_unsupported",
					"photos_image_too_large",
				].includes(error.message))
		)
			return {
				status: "rejected",
				message: imageUploadMessage(error.message, error.status),
				canRetry: ![
					"photos_session_changed",
					"photos_session_expired",
					"photos_authorization_required",
				].includes(error.message),
			};
		try {
			view = await client.imageImport(requestId, signal);
		} catch {
			signal.throwIfAborted();
			return {
				status: "indeterminate",
				message:
					"アップロード結果が未確認です。「状態を再確認」で同じ受付番号を確認してください。",
			};
		}
	}
	const deadline = Date.now() + 60_000;
	while (view.status === "pending" && Date.now() < deadline) {
		await waitForImagePoll(view.retryAfterMs, signal);
		try {
			view = await client.imageImport(requestId, signal);
		} catch {
			signal.throwIfAborted();
			return {
				status: "indeterminate",
				message: imageUploadMessage(undefined),
			};
		}
	}
	if (view.status === "succeeded" && view.artifact) {
		if (view.artifact.width < 32 || view.artifact.height < 32)
			return {
				status: "rejected",
				message:
					"保存できましたが、3D生成には縦横とも32px以上の画像が必要です。",
				canRetry: false,
			};
		return {
			status: "accepted",
			message: "画像をアップロードしました。",
			value: view.artifact.id,
		};
	}
	return {
		status: ["pending", "unknown", "ready"].includes(view.status)
			? "indeterminate"
			: "rejected",
		message: imageUploadMessage(
			view.errorCode,
			view.httpStatus,
			view.status === "failed"
				? "画像の取込に失敗しました。やり直す場合は「もう一度アップロード」を押してください。"
				: undefined,
		),
		canRetry: view.status === "failed",
	};
}

export const uploadImage = (
	client: EumenesClient,
	requestId: string,
	file: File,
	signal: AbortSignal,
) =>
	settleImageImport(
		client,
		requestId,
		() => client.importImage(requestId, file, signal),
		signal,
	);
