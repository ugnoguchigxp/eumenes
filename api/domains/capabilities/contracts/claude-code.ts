import { z } from "zod";

/** Flat command input of the registered Claude Code request tool. */
export const claudeCodeRequest = z.strictObject({
	prompt: z
		.string()
		.trim()
		.min(1)
		.max(8000)
		.describe(
			"Claude Code に渡す依頼文。利用者の指示・対象・条件をそのまま含め、要約や推測で変えない。",
		),
	task: z
		.string()
		.trim()
		.min(1)
		.max(40)
		.describe(
			"作業の短い名前（例: README の手順修正）。利用者の依頼の言葉から選び、完了の報告でこの名前を使う。",
		),
	session: z
		.enum(["current", "new"])
		.optional()
		.describe(
			"current（既定）は実行中のセッションへ続けて依頼する。new は利用者が別のセッションを明示した場合だけ。",
		),
});
