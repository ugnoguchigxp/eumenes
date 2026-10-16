import { z } from "zod";

/** Frozen deployed schema of tool:web.lookup@1, including its description fingerprint. */
export const lookupInputV1 = z
	.object({
		query: z.string().trim().min(1).max(400),
		language: z
			.string()
			.regex(/^[a-z]{2}$/)
			.default("ja"),
		region: z
			.string()
			.regex(/^[A-Z]{2}$/)
			.describe("ISO region. Use JP with ja, US with en.")
			.optional(),
		timeRange: z.enum(["day", "week", "month", "year"]).optional(),
	})
	.strict();

/** Current schema: region and publication time are independent search conditions. */
export const lookupInput = lookupInputV1.extend({
	region: z
		.string()
		.regex(/^[A-Z]{2}$/)
		.describe(
			"検索対象の国・地域をISO 3166-1 alpha-2で指定する。検索言語とは独立に選ぶ。",
		)
		.optional(),
	timeRange: z
		.enum(["day", "week", "month", "year"])
		.describe(
			"ページの公開・更新時刻の制限。値や予報の対象日とは別。公開期間を絞る依頼の場合だけ指定し、通常は省略する。",
		)
		.optional(),
});
