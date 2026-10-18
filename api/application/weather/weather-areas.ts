import { z } from "zod";

/**
 * The places a weather request may name, read from the forecast agency's published list of areas
 * (spec weather-instant-toolchain-design §7). Its forecast areas (class10) carry the same six-digit ids as the
 * forecast service; the municipalities (class20) and the regions between (class15) say which area a place is in.
 */
export type WeatherPlace = {
	/** What the answer calls the place ("鎌倉市"). */
	name: string;
	/** The forecast area the answer notes ("神奈川県東部"). */
	region: string;
	/** The forecast service's id of that area. */
	id: string;
};
export type WeatherAreas = {
	resolve(place: string, prefecture: string): WeatherPlace | undefined;
	size: number;
};

/** The prefectures by their two-digit code, with the municipality of each prefectural office. */
const PREFECTURES: ReadonlyArray<readonly [string, string]> = [
	["北海道", "札幌市"],
	["青森県", "青森市"],
	["岩手県", "盛岡市"],
	["宮城県", "仙台市"],
	["秋田県", "秋田市"],
	["山形県", "山形市"],
	["福島県", "福島市"],
	["茨城県", "水戸市"],
	["栃木県", "宇都宮市"],
	["群馬県", "前橋市"],
	["埼玉県", "さいたま市"],
	["千葉県", "千葉市"],
	["東京都", "千代田区"],
	["神奈川県", "横浜市"],
	["新潟県", "新潟市"],
	["富山県", "富山市"],
	["石川県", "金沢市"],
	["福井県", "福井市"],
	["山梨県", "甲府市"],
	["長野県", "長野市"],
	["岐阜県", "岐阜市"],
	["静岡県", "静岡市"],
	["愛知県", "名古屋市"],
	["三重県", "津市"],
	["滋賀県", "大津市"],
	["京都府", "京都市"],
	["大阪府", "大阪市"],
	["兵庫県", "神戸市"],
	["奈良県", "奈良市"],
	["和歌山県", "和歌山市"],
	["鳥取県", "鳥取市"],
	["島根県", "松江市"],
	["岡山県", "岡山市"],
	["広島県", "広島市"],
	["山口県", "山口市"],
	["徳島県", "徳島市"],
	["香川県", "高松市"],
	["愛媛県", "松山市"],
	["高知県", "高知市"],
	["福岡県", "福岡市"],
	["佐賀県", "佐賀市"],
	["長崎県", "長崎市"],
	["熊本県", "熊本市"],
	["大分県", "大分市"],
	["宮崎県", "宮崎市"],
	["鹿児島県", "鹿児島市"],
	["沖縄県", "那覇市"],
];
const prefectureOf = (code: string) =>
	PREFECTURES[Number(code.slice(0, 2)) - 1]?.[0];

/** More entries than the list has by far; a list beyond them is not the list. */
const MAX_AREAS = 400;
const MAX_PLACES = 4000;

const entry = z.object({
	name: z.string().min(1).max(40),
	parent: z.string().regex(/^\d{6,7}$/),
});
const areaList = z.object({
	class10s: z.record(
		z.string().regex(/^\d{6}$/),
		z.object({ name: z.string().min(1).max(40) }),
	),
	class15s: z.record(z.string().regex(/^\d{6}$/), entry),
	class20s: z.record(z.string().regex(/^\d{7}$/), entry),
});

const normal = (name: string) => name.normalize("NFKC").replace(/\s+/g, "");
/** The name without the suffix people leave off: 「鎌倉市」「東京都」→「鎌倉」「東京」 (but 「京都」 stays). */
function bare(name: string) {
	const n = normal(name);
	const stripped = n.replace(/[市町村区都府県]$/, "");
	return stripped.length >= 2 ? stripped : n;
}

/**
 * Parse the list. Anything that is not the plain three levels (a parent that is not there, an area id the
 * prefecture table does not know, too many entries) is refused as a whole, so a changed document never
 * leaves a half-known list.
 */
export function parseAreas(text: string): WeatherAreas {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new Error("weather_areas_invalid");
	}
	const parsed = areaList.safeParse(raw);
	if (!parsed.success) throw new Error("weather_areas_invalid");
	const { class10s, class15s, class20s } = parsed.data;
	const areaIds = Object.keys(class10s);
	if (
		!areaIds.length ||
		areaIds.length > MAX_AREAS ||
		Object.keys(class20s).length > MAX_PLACES ||
		areaIds.some((id) => !prefectureOf(id))
	)
		throw new Error("weather_areas_invalid");
	const area = (id: string): WeatherPlace & { prefecture: string } => {
		const prefecture = prefectureOf(id)!;
		const name = class10s[id]!.name;
		// 「東部」→「神奈川県東部」; an area already named for its prefecture (「大阪府」「東京地方」) stays.
		const region = name.startsWith(bare(prefecture))
			? name
			: `${prefecture}${name}`;
		return { name: "", region, id, prefecture };
	};
	const areaOf15 = (code: string) => {
		const parent = class15s[code]?.parent;
		if (!parent || !class10s[parent]) throw new Error("weather_areas_invalid");
		return parent;
	};

	type Candidate = WeatherPlace & { prefecture: string };
	// Three levels, matched in order: municipality, region or area, prefecture.
	const levels: Array<Map<string, Candidate[]>> = [
		new Map(),
		new Map(),
		new Map(),
	];
	// Each name is found by itself and without its suffix (「津市」 by 「津市」 and 「津」).
	const add = (level: number, name: string, place: Candidate) => {
		const n = normal(name);
		for (const k of new Set([n, n.replace(/[市町村区都府県]$/, "") || n])) {
			const list = levels[level]!.get(k) ?? [];
			if (!list.some((p) => p.id === place.id && p.name === place.name))
				list.push(place);
			levels[level]!.set(k, list);
		}
	};
	const municipalities = new Map<string, Candidate>();
	for (const [code, { name, parent }] of Object.entries(class20s)) {
		const place = { ...area(areaOf15(parent)), name };
		add(0, name, place);
		// A city split in parts (「横浜市北部」) is the city as well.
		const city = /^(.+?[市町村])./.exec(name)?.[1];
		if (city) {
			const whole = { ...place, name: city };
			add(0, city, whole);
			if (!municipalities.has(`${code.slice(0, 2)}${city}`))
				municipalities.set(`${code.slice(0, 2)}${city}`, whole);
		}
		municipalities.set(`${code.slice(0, 2)}${name}`, place);
	}
	for (const [code, { name }] of Object.entries(class15s))
		add(1, name, { ...area(areaOf15(code)), name });
	for (const id of areaIds) {
		const a = area(id);
		add(1, class10s[id]!.name, { ...a, name: a.region });
	}
	PREFECTURES.forEach(([prefecture, office], i) => {
		const seat = municipalities.get(
			`${String(i + 1).padStart(2, "0")}${office}`,
		);
		if (seat) add(2, prefecture, { ...seat, name: prefecture });
	});

	return {
		size: areaIds.length,
		resolve(place, prefecture) {
			const keys = [...new Set([normal(place), bare(place)])];
			const pref = bare(prefecture);
			for (const level of levels) {
				const found = keys.map((k) => level.get(k)).find((l) => l?.length);
				if (!found) continue;
				const chosen =
					found.find((p) => bare(p.prefecture) === pref) ?? found[0]!;
				return { name: chosen.name, region: chosen.region, id: chosen.id };
			}
			return undefined;
		},
	};
}
