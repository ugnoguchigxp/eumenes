import { z } from "zod";

/**
 * The arguments of the stock-quote toolchain's function: the company name or ticker as the user said it.
 * The host resolves it to one listed company; the model never writes a ticker it was not told.
 */
export const stockQuote = z
	.object({
		query: z
			.string()
			.trim()
			.min(1)
			.max(60)
			.describe(
				"株価を知りたい会社名またはティッカー・証券コード。言われたとおりに書く（例: ソフトバンク、トヨタ自動車、AAPL、9434）。株価・円・「の」などの語は含めない。",
			),
	})
	.strict();
