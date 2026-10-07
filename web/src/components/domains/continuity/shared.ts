import type {
	Bookmark,
	BookmarkEvent,
	SourceStatus,
} from "../../../../../api/domains/continuity/contracts";
import { ApiError } from "../../../../../client/transport";

export const kindLabels: Record<Bookmark["kind"], string> = {
	goal: "目的",
	decision: "決定・制約",
	open_question: "未決事項",
};
export const kinds = Object.keys(kindLabels) as Bookmark["kind"][];
export const operationLabels: Record<BookmarkEvent["operation"], string> = {
	create: "作成",
	revise: "訂正",
	deactivate: "無効化",
};
export const sourceStatusLabels: Record<SourceStatus, string> = {
	ok: "出典と一致",
	missing: "欠落",
	changed: "変更あり",
};
export const originLabels: Record<Bookmark["origin"], string> = {
	user_confirmed: "ユーザー確認",
	user_edited: "ユーザー編集",
};

export const isConflict = (error: unknown) =>
	error instanceof ApiError && error.status === 409;
export function saveErrorMessage(error: unknown): string {
	if (isConflict(error))
		return "他の更新と競合しました。入力内容は残してあります。最新の状態を確認してから、もう一度操作してください。";
	return `保存できませんでした: ${error instanceof Error ? error.message : "不明なエラー"}`;
}
