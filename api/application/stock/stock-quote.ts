import { z } from "zod";

/** What the chart service says about one symbol, reduced to the values the sentence uses. */
export type Quote = {
	/** The company's own name as the service gives it (English), used only when the resolution had none. */
	name?: string;
	currency: string;
	price: number;
	previousClose?: number;
	/** When the price was set, in seconds since the epoch. */
	time?: number;
};

const finite = z.number().refine(Number.isFinite);
const chartBody = z.object({
	chart: z.object({
		result: z
			.array(
				z.object({
					meta: z.object({
						currency: z.string().nullable().optional(),
						regularMarketPrice: finite.nullable().optional(),
						chartPreviousClose: finite.nullable().optional(),
						regularMarketTime: finite.nullable().optional(),
						longName: z.string().nullable().optional(),
						shortName: z.string().nullable().optional(),
					}),
				}),
			)
			.min(1),
	}),
});

/**
 * The quote in the chart service's answer. A price and its currency must be there, or the answer is
 * refused; the previous close and the time are left out when the service does not give them.
 */
export function parseChart(body: unknown): Quote {
	const parsed = chartBody.safeParse(body);
	const meta = parsed.success ? parsed.data.chart.result[0]!.meta : undefined;
	const currency = meta?.currency?.trim();
	const price = meta?.regularMarketPrice;
	if (
		!meta ||
		!currency ||
		!/^[A-Za-z]{3}$/.test(currency) ||
		!price ||
		price <= 0
	)
		throw new Error("stock_chart_invalid");
	const previous = meta.chartPreviousClose;
	const time = meta.regularMarketTime;
	const name = (meta.longName ?? meta.shortName)?.trim();
	return {
		...(name ? { name } : {}),
		currency,
		price,
		...(previous && previous > 0 ? { previousClose: previous } : {}),
		...(time && time > 0 ? { time } : {}),
	};
}

/** How the amount is written after the number; a currency not listed is written as its code. */
const units: Record<string, string> = {
	JPY: "円",
	USD: "ドル",
	EUR: "ユーロ",
	GBP: "ポンド",
	GBp: "ペンス",
	HKD: "香港ドル",
	CNY: "人民元",
	KRW: "ウォン",
	TWD: "台湾ドル",
	SGD: "シンガポールドル",
	CAD: "カナダドル",
	AUD: "豪ドル",
	CHF: "スイスフラン",
	INR: "ルピー",
};

const JST_OFFSET_MS = 9 * 3_600_000;

/** "10/16 15:30" in Japan time. */
function stamp(seconds: number) {
	const jst = new Date(seconds * 1000 + JST_OFFSET_MS);
	const minutes = String(jst.getUTCMinutes()).padStart(2, "0");
	return `${jst.getUTCMonth() + 1}/${jst.getUTCDate()} ${jst.getUTCHours()}:${minutes}`;
}

function decimals(value: number) {
	const text = String(Number(value.toFixed(4)));
	return text.includes(".") ? text.split(".")[1]!.length : 0;
}

const sign = (value: number) => (value > 0 ? "+" : value < 0 ? "-" : "±");

/**
 * The fixed sentence for one quote:
 * 「ソフトバンク株式会社（9434）の株価は244.7円、前日比+2.0円（+0.82%）です。10/16 15:30時点。」
 * The company's name and code are always in it, so the user can tell it is another company when it is.
 * A value the service does not give (the previous close, the time) is left out; it is never filled in.
 */
export function quoteSentence(
	quote: Quote,
	subject: { name: string; code: string },
): string {
	const known = Object.hasOwn(units, quote.currency);
	const unit = known ? units[quote.currency]! : quote.currency;
	const shown = Math.min(
		Math.max(decimals(quote.price), decimals(quote.previousClose ?? 0)),
		4,
	);
	const money = (value: number) => {
		const number = value.toLocaleString("en-US", {
			minimumFractionDigits: shown,
			maximumFractionDigits: shown,
		});
		return known ? `${number}${unit}` : `${number} ${unit}`;
	};
	let change = "";
	if (quote.previousClose !== undefined) {
		const diff = Number((quote.price - quote.previousClose).toFixed(shown));
		const percent = Number(
			(
				((quote.price - quote.previousClose) / quote.previousClose) *
				100
			).toFixed(2),
		);
		change = `、前日比${sign(diff)}${money(Math.abs(diff))}（${percent === 0 ? "" : sign(percent)}${Math.abs(percent).toFixed(2)}%）`;
	}
	const time = quote.time === undefined ? "" : `${stamp(quote.time)}時点。`;
	return `${subject.name}（${subject.code}）の株価は${money(quote.price)}${change}です。${time}`;
}
