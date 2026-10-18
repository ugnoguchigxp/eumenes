import { z } from "zod";

/** The days a weather forecast can name: the three the forecast service returns. */
export const weatherDays = ["today", "tomorrow", "day_after"] as const;

/**
 * The arguments of the weather toolchain's function. The model writes the place as it was said and the
 * prefecture it is in; the host finds the forecast area (spec weather-instant-toolchain-design §7).
 */
export const weatherPlace = z
	.object({
		place: z
			.string()
			.trim()
			.min(1)
			.max(30)
			.describe(
				"天気を知りたい場所。依頼の地名をそのまま書く（例: 鎌倉、横浜、湘南、北海道）。市区町村・地域・都道府県のどれでもよい。",
			),
		prefecture: z
			.string()
			.trim()
			.min(2)
			.max(5)
			.describe(
				"その場所がある都道府県（例: 神奈川県）。依頼に無くても、知っている場所なら書く。",
			),
		day: z
			.enum(weatherDays)
			.describe(
				"天気を知りたい日。today=今日、tomorrow=明日、day_after=明後日。日付や曜日で言われたときは今日からの日数で選ぶ。",
			),
	})
	.strict();
