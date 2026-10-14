import { z } from "zod";

/** Input of the conversation agent's `memory_request` tool (the steward validates the same shape). */
export const memoryRequest = z.strictObject({
	kind: z
		.enum(["forget", "remember", "correct", "goal"])
		.describe(
			"forget は本人が忘れてと頼んだとき、remember は覚えてと頼んだとき、correct は記憶の内容が違うと言われたとき、goal は目標を登録・変更・完了・取り下げてと頼まれたとき。",
		),
	what: z
		.string()
		.trim()
		.min(1)
		.max(500)
		.describe(
			"対象の内容。本人の言葉から、何を忘れる・覚える・直すのかが分かる短い文にする。",
		),
	detail: z
		.string()
		.trim()
		.max(1000)
		.optional()
		.describe("correct の正しい内容など、補足があるときだけ。"),
});
