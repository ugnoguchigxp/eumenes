import type { Receipt } from "@eumenes/artifact-ui/contracts";
import type { FieldError } from "../../../../api/domains/tool-runtime/contracts";
import type { ActionOutcome } from "./dispatcher";

/** Wording for the safe error codes the action host returns. Unknown codes stay generic. */
const codeMessages: Record<string, string> = {
	revision_conflict:
		"状態が変わりました。最新の表示を読み込みました。もう一度お試しください。",
	request_conflict:
		"同じ操作IDで内容が異なるため受け付けられません。画面を更新してやり直してください。",
	event_expired: "操作の有効期限が切れました。もう一度操作してください。",
	artifact_unavailable: "この画面は現在利用できません。",
	action_unavailable: "この操作は現在利用できません。",
	action_capacity:
		"処理が混み合っています。しばらくしてから、もう一度同じ操作をお試しください。",
	invalid_input: "入力内容を確認してください。",
	source_forbidden: "この操作は利用できません。",
	timer_not_found: "対象が見つかりません。画面を更新してください。",
	operation_expired: "表示期限が過ぎています。",
	scope_mismatch:
		"この画面を開いた時と利用者の範囲が変わりました。画面を開き直してください。",
	payload_too_large: "入力が大きすぎます。",
	invalid_params: "表示の条件を確認してください。",
	event_time_invalid:
		"この端末の時刻がずれているため操作を受け付けられませんでした。端末の日時を正しく設定してから、もう一度お試しください。",
	outbox_full:
		"結果を確認できていない操作が多く残っています。接続を確認し、確認が済んでからもう一度お試しください。",
};

export const unsettledMessage =
	"操作の結果を確認できていません。確認でき次第反映します（二重には実行しません）";
export const pendingMessage = "操作を受け付けました。結果を確認しています";

export function rejectionMessage(
	code: string | undefined,
	fieldErrors: readonly FieldError[],
	describeDomain?: (
		code: string | undefined,
		fieldErrors: ReadonlyArray<FieldError>,
	) => string | undefined,
): string {
	const domain = describeDomain?.(code, fieldErrors);
	if (domain) return domain;
	// The server's per-field messages are validation codes, not wording for people.
	if (fieldErrors.length)
		return `入力内容を確認してください（${fieldErrors.map((error) => error.field).join("・")}）。`;
	return (
		(code && codeMessages[code]) ||
		"操作を完了できませんでした。もう一度お試しください。"
	);
}

/** The UI receipt for an outcome: pending and indeterminate are never reported as failures. */
export function receiptOf(
	outcome: ActionOutcome,
	describe: (
		code: string | undefined,
		fieldErrors: readonly FieldError[],
	) => string,
): Receipt {
	switch (outcome.kind) {
		case "accepted":
			return { status: "accepted", message: "" };
		case "rejected":
			return {
				status: outcome.conflict ? "conflict" : "rejected",
				message: describe(outcome.code, outcome.fieldErrors),
			};
		case "pending":
			return { status: "pending", message: pendingMessage };
		case "indeterminate":
			return { status: "indeterminate", message: unsettledMessage };
	}
}
