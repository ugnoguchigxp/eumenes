import { z } from "zod";

/** The days the toolchain answers, as the forecast service labels them. */
export type WeatherDay = "today" | "tomorrow" | "day_after";
const dayLabels: Record<WeatherDay, string> = {
	today: "今日",
	tomorrow: "明日",
	day_after: "明後日",
};

const celsius = z.object({ celsius: z.string().nullable().optional() });
/** The parts of the service's answer this sentence reads; the rest is not looked at. */
const forecastBody = z.object({
	publicTime: z.string().optional(),
	forecasts: z.array(
		z.object({
			date: z.string(),
			dateLabel: z.string(),
			telop: z.string().nullable().optional(),
			temperature: z
				.object({
					min: celsius.nullable().optional(),
					max: celsius.nullable().optional(),
				})
				.nullable()
				.optional(),
			chanceOfRain: z
				.record(z.string(), z.string().nullable())
				.nullable()
				.optional(),
		}),
	),
});

const JST_OFFSET_MS = 9 * 3_600_000;

function degrees(value: string | null | undefined) {
	return value && /^-?\d{1,3}(\.\d)?$/.test(value) ? value : undefined;
}

/** The highest of the periods' chances of rain; a period without a number ("--%") is not counted. */
function chanceOfRain(
	periods: Record<string, string | null> | null | undefined,
) {
	const numbers = Object.values(periods ?? {}).flatMap((p) => {
		const m = /^(\d{1,3})%$/.exec(p ?? "");
		return m ? [Number(m[1])] : [];
	});
	return numbers.length ? Math.max(...numbers) : undefined;
}

/** "5時" / "4時35分" in Japan time, or undefined when the time cannot be read. */
function announced(publicTime: string | undefined) {
	const ms = publicTime ? Date.parse(publicTime) : Number.NaN;
	if (Number.isNaN(ms)) return undefined;
	const jst = new Date(ms + JST_OFFSET_MS);
	const minutes = jst.getUTCMinutes();
	return `${jst.getUTCHours()}時${minutes ? `${minutes}分` : ""}発表`;
}

/**
 * The fixed sentence for one day of the forecast service's answer, about the place the request named and
 * noting the forecast area it is in:
 * 「明日（10/19）の鎌倉市は曇時々晴、最高26℃・最低19℃、降水確率は最大20%です（神奈川県東部の予報・5時発表）。」
 * A value the service does not give (a minimum already past, a period without a chance of rain) is left
 * out of the sentence; it is never filled in. The weather itself must be there, or the answer is refused.
 */
export function forecastSentence(
	body: unknown,
	day: WeatherDay,
	place: { name: string; region: string },
): string {
	const parsed = forecastBody.safeParse(body);
	if (!parsed.success) throw new Error("weather_forecast_invalid");
	const found = parsed.data.forecasts.find(
		(f) => f.dateLabel === dayLabels[day],
	);
	const date = found && /^\d{4}-(\d{2})-(\d{2})$/.exec(found.date);
	const telop = found?.telop?.trim();
	if (!found || !date || !telop) throw new Error("weather_forecast_invalid");
	const max = degrees(found.temperature?.max?.celsius);
	const min = degrees(found.temperature?.min?.celsius);
	const temperature = [
		...(max === undefined ? [] : [`最高${max}℃`]),
		...(min === undefined ? [] : [`最低${min}℃`]),
	].join("・");
	const rain = chanceOfRain(found.chanceOfRain);
	const parts = [
		telop,
		...(temperature ? [temperature] : []),
		...(rain === undefined ? [] : [`降水確率は最大${rain}%`]),
	];
	const time = announced(parsed.data.publicTime);
	const note = [`${place.region}の予報`, ...(time ? [time] : [])].join("・");
	return `${dayLabels[day]}（${Number(date[1])}/${Number(date[2])}）の${place.name}は${parts.join("、")}です（${note}）。`;
}
