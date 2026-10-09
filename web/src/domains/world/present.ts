import { ApiError } from "../../../../client";
import type {
	ClaimAdoption,
	ClaimContent,
	ClaimEvidenceKind,
	ClaimFreshness,
	ClaimOrigin,
	ClaimTone,
	ForgetDisplay,
} from "../../../../api/domains/world/contracts";

/**
 * Words for the World screen. Each axis (adoption, evidence, origin,
 * freshness) has its own table: none of them is folded into another, and the
 * tone of a claim says how it may be STYLED (only `adopted` is the confirmed
 * style).
 */
export const adoptionLabels: Record<ClaimAdoption, string> = {
	adopted: "採用",
	disputed: "争い中",
	candidate: "未採用",
};
export const toneLabels: Record<ClaimTone, string> = {
	adopted: "採用済み",
	measured: "実測（採用済み）",
	hypothesis: "仮説（採用しても未確認）",
	candidate: "候補（未採用）",
	disputed: "争い中",
};
export const evidenceLabels: Record<ClaimEvidenceKind, string> = {
	user_statement: "本人の発言",
	document: "資料",
	runtime_measurement: "実測",
	assistant_summary: "アシスタントの要約",
};
export const originLabels: Record<ClaimOrigin, string> = {
	user_report: "本人の報告",
	document_claim: "資料の主張",
	runtime_observation: "実行時の観測",
	model_hypothesis: "モデルの仮説",
};
export const freshnessLabels: Record<ClaimFreshness, string> = {
	fresh: "新しい",
	stale: "古い",
	unknown: "不明",
};
export const sourceStateLabels = {
	current: "現在の版",
	changed: "版が変わった",
	unavailable: "参照できない",
} as const;
export const conditionLabels = {
	satisfied: "成立",
	violated: "不成立",
	unknown: "未確認",
} as const;

/** Forgetting: only `complete` may be read as done. */
export const forgetLabels: Record<ForgetDisplay, string> = {
	pending: "処理中（完了ではありません）",
	awaiting_confirmation: "外部の削除の確認待ち（完了ではありません）",
	abandoned: "一部を実行できませんでした（完了ではありません）",
	complete: "完了",
};

export const contentText = (content: ClaimContent): string => {
	if (content.kind === "relation")
		return `${content.relation} → ${content.objectId}`;
	const v = content.value;
	switch (v.kind) {
		case "string":
			return v.value;
		case "boolean":
			return v.value ? "はい" : "いいえ";
		case "number":
			return `${v.value}${v.unit ? ` ${v.unit}` : ""}`;
		case "entity":
			return v.entityId;
	}
};

/** What a failed action means to the person; the screen reloads on the ones that say so. */
export type ActionFailure = {
	message: string;
	/** The claim changed or went away: reload before anything else. */
	reload: boolean;
};
export function failureOf(error: unknown): ActionFailure {
	if (error instanceof ApiError) {
		if (error.message === "revision_conflict")
			return {
				message:
					"この主張は他の操作で変わりました。最新の内容を読み込みました。内容を確かめてから、もう一度操作してください。",
				reload: true,
			};
		if (error.message === "reason_source_unavailable")
			return {
				message: "理由に選んだ発言を使えません。別の発言を選んでください。",
				reload: false,
			};
		if (error.message === "world_disabled")
			return { message: "Worldがオフのため操作できません。", reload: true };
		if (error.message === "claim_not_changeable")
			return { message: "この主張は変更できません。", reload: true };
		if (error.status === 404)
			return {
				message: "対象を見つけられません。最新の一覧を読み込みました。",
				reload: true,
			};
		if (error.status === 503)
			return {
				message: "いま受け付けられません。少し待ってからやり直してください。",
				reload: false,
			};
		if (error.status === 400)
			return { message: "入力内容を確認してください。", reload: false };
	}
	return { message: "操作できませんでした。", reload: false };
}
