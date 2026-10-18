/**
 * A trimmed copy of the forecast agency's list of areas (2026-10-18), for fixtures that never reach the network:
 * the municipalities of 鎌倉・横浜・箱根 and the two cities named 府中, with the regions and areas above them.
 */
export const areasJson = JSON.stringify({
	centers: {},
	offices: {},
	class10s: {
		"130010": { name: "東京地方" },
		"140010": { name: "東部" },
		"140020": { name: "西部" },
		"340010": { name: "南部" },
	},
	class15s: {
		"130013": { name: "多摩北部", parent: "130010" },
		"140011": { name: "横浜・川崎", parent: "140010" },
		"140013": { name: "三浦半島", parent: "140010" },
		"140024": { name: "西湘", parent: "140020" },
		"340012": { name: "福山・尾三", parent: "340010" },
	},
	class20s: {
		"1320600": { name: "府中市", kana: "ふちゅうし", parent: "130013" },
		"1410011": { name: "横浜市北部", parent: "140011" },
		"1410012": { name: "横浜市南部", parent: "140011" },
		"1420400": { name: "鎌倉市", parent: "140013" },
		"1438200": { name: "箱根町", parent: "140024" },
		"3420800": { name: "府中市", parent: "340012" },
	},
});

type Day = {
	date: string;
	dateLabel: string;
	telop: string | null;
	min: string | null;
	max: string | null;
	rain: [string, string, string, string];
};

/** The service's answer for one area, trimmed to the fields the sentence reads (the shape of 2026-10-18). */
export function forecastJson(
	days: Day[] = [
		{
			date: "2026-10-18",
			dateLabel: "今日",
			telop: "晴れ",
			min: null,
			max: "24",
			rain: ["--%", "0%", "0%", "0%"],
		},
		{
			date: "2026-10-19",
			dateLabel: "明日",
			telop: "曇時々晴",
			min: "19",
			max: "26",
			rain: ["0%", "0%", "10%", "20%"],
		},
		{
			date: "2026-10-20",
			dateLabel: "明後日",
			telop: "曇り",
			min: "22",
			max: "27",
			rain: ["40%", "40%", "40%", "40%"],
		},
	],
) {
	return {
		publicTime: "2026-10-18T05:00:00+09:00",
		publishingOffice: "横浜地方気象台",
		title: "神奈川県 横浜 の天気",
		forecasts: days.map((d) => ({
			date: d.date,
			dateLabel: d.dateLabel,
			telop: d.telop,
			detail: { weather: d.telop, wind: null, wave: null },
			temperature: {
				min: { celsius: d.min, fahrenheit: null },
				max: { celsius: d.max, fahrenheit: null },
			},
			chanceOfRain: {
				T00_06: d.rain[0],
				T06_12: d.rain[1],
				T12_18: d.rain[2],
				T18_24: d.rain[3],
			},
		})),
		location: {
			area: "関東",
			prefecture: "神奈川県",
			district: "東部",
			city: "横浜",
		},
	};
}

export const tomorrowKamakura =
	"明日（10/19）の鎌倉市は曇時々晴、最高26℃・最低19℃、降水確率は最大20%です（神奈川県東部の予報・5時発表）。";

/** A fetch that answers the two documents from fixtures and records every address asked. */
export function weatherFetch(
	over: {
		areas?: () => Response;
		forecast?: (id: string) => Response;
	} = {},
) {
	const urls: string[] = [];
	const fetcher = (async (input: string | URL | Request) => {
		const url = String(input);
		urls.push(url);
		if (url.endsWith("/area.json"))
			return (
				over.areas?.() ??
				new Response(areasJson, {
					headers: { "content-type": "application/json" },
				})
			);
		const id = /\/api\/forecast\/city\/(\d+)$/.exec(url)?.[1];
		if (!id) return new Response("not found", { status: 404 });
		return (
			over.forecast?.(id) ??
			new Response(JSON.stringify(forecastJson()), {
				headers: { "content-type": "application/json" },
			})
		);
	}) as typeof fetch;
	return { fetch: fetcher, urls };
}
