import { z } from "zod";
import type { Snapshot, FormResource } from "@eumenes/artifact-ui/contracts";

const run = z.object({
	runId: z.string(),
	conversationId: z.string(),
	parentExecutionId: z.string().nullable(),
	state: z.enum([
		"queued",
		"running",
		"needs_input",
		"completed",
		"partial",
		"failed",
		"cancelled",
		"expired",
		"indeterminate",
	]),
	code: z.string().nullable(),
	generation: z.number(),
	revision: z.number(),
	calls: z.number(),
	deadline: z.number(),
	question: z
		.object({
			id: z.string(),
			kind: z.enum(["approval", "capture", "text"]).nullable(),
			text: z.string(),
			deadline: z.number().nullable(),
		})
		.nullable(),
	answer: z.string().nullable(),
	captures: z.array(
		z.object({
			captureId: z.string(),
			width: z.number(),
			height: z.number(),
			bytes: z.number(),
			expiresAt: z.number(),
		}),
	),
});
export const interactWorkspace = z.object({
	runs: z.array(run),
	selected: run.nullable(),
	selectedCaptureId: z.string().nullable().optional(),
});
export type InteractWorkspace = z.infer<typeof interactWorkspace>;
const labels: Record<z.infer<typeof run>["state"], string> = {
	queued: "受付済み",
	running: "実行中",
	needs_input: "確認待ち",
	completed: "完了",
	partial: "一部完了",
	failed: "未完了",
	cancelled: "取消済み",
	expired: "期限切れ",
	indeterminate: "結果不明",
};
export function interactSnapshot(
	data: InteractWorkspace,
	conversationId: string,
	now: number,
	image?: string,
): Snapshot {
	const v = data.selected;
	const active = !!v && ["queued", "running", "needs_input"].includes(v.state);
	const q = v?.question;
	const canAnswer = !!q && !v?.parentExecutionId && (q.deadline ?? 0) > now;
	const reply: FormResource = {
		identity: q?.id ?? "none",
		kind: "form",
		revision: v?.revision ?? 0,
		disabled: !canAnswer,
		submitLabel: q?.kind === "text" ? "回答を送る" : "選択を送る",
		fields:
			q?.kind === "text"
				? [
						{
							id: "text",
							label: "確認への回答",
							type: "textarea",
							required: true,
						},
					]
				: q
					? [
							{
								id: "decision",
								label: "確認への回答",
								type: "radio",
								required: true,
								options: ["allow", "deny"],
								optionLabels: { allow: "実行する", deny: "実行しない" },
							},
						]
					: [],
		defaults:
			v && q
				? {
						runId: v.runId,
						conversationId: v.conversationId,
						questionId: q.id,
						generation: String(v.generation),
						expectedRevision: String(v.revision),
					}
				: {},
	};
	return {
		setup: {
			identity: conversationId,
			kind: "form",
			revision: 0,
			submitLabel: "作業を始める",
			fields: [
				{ id: "request", label: "依頼内容", type: "textarea", required: true },
				{ id: "url", label: "開始するURL", type: "text", required: true },
			],
			defaults: { conversationId },
		},
		runs: {
			kind: "work-menu",
			revision: v?.revision ?? 0,
			items: data.runs.map((r) => ({
				id: r.runId,
				label: `ブラウザ作業 ${new Date(r.deadline - 600000).toLocaleTimeString("ja-JP")}`,
				status: labels[r.state],
			})),
			selectedId: v?.runId,
			selectedTitle: "ブラウザ作業（検証）",
			message: v?.parentExecutionId
				? "この作業の回答・取消・削除は、依頼した会話から行ってください。"
				: undefined,
		},
		result: {
			kind: "work-result",
			revision: v?.revision ?? 0,
			targetRef: v?.runId,
			...(v
				? {
						work: {
							title: "ブラウザ作業",
							status: labels[v.state],
							summary:
								v.answer ??
								v.question?.text ??
								(v.code
									? "作業が停止しました。保存された状態を確認してください。"
									: undefined),
							canPause: false,
							canCancel: active && !v.parentExecutionId,
							sections: [
								{
									title: "実行状況",
									items: [
										`推論 ${v.calls} 回`,
										`期限 ${new Date(v.deadline).toLocaleString("ja-JP")}`,
										...(v.captures.length
											? [`保存した撮影 ${v.captures.length} 件`]
											: []),
									],
								},
							],
						},
					}
				: {}),
		},
		reply,
		capture: {
			kind: "generated-image",
			revision: v?.revision ?? 0,
			status: image ? "succeeded" : active ? "running" : "cancelled",
			url: image,
			mimeType: "image/webp",
			alt: "利用者が保存を許可した撮影",
			emptyMessage: "撮影を保存すると、ここに表示します。",
		},
		forget: {
			identity: v?.runId ?? "none",
			kind: "form",
			revision: v?.revision ?? 0,
			disabled: !v || !!v.parentExecutionId,
			submitLabel: "この作業と撮影を削除",
			fields: [
				{
					id: "confirmed",
					label: "この作業と保存した撮影を削除する",
					type: "boolean",
					required: true,
				},
			],
			defaults: { confirmed: false },
		},
	};
}

/** Resource navigation names an exact capture; only an unselected run defaults to its latest image. */
export function selectedInteractCapture(data: InteractWorkspace | undefined) {
	const captures = data?.selected?.captures;
	return data?.selectedCaptureId
		? captures?.find((c) => c.captureId === data.selectedCaptureId)
		: captures?.at(-1);
}
