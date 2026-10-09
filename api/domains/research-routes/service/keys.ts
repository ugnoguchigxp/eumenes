import {
	canonicalJson,
	keyVersion,
	quoteFields,
	type BuiltSpec,
	type QuoteSpec,
	type RequestBinding,
	type SearchSpec,
	searchSpec,
	sha256,
	validationPolicyVersion,
	type WeatherSpec,
} from "../contracts";

/** Confirmed host table (initial release). Anything else is unsupported or ambiguous. */
const places: Record<
	string,
	{ name: string; prefecture: string; display: string }
> = {
	鎌倉: { name: "鎌倉市", prefecture: "神奈川県", display: "鎌倉" },
	鎌倉市: { name: "鎌倉市", prefecture: "神奈川県", display: "鎌倉" },
	静岡市: { name: "静岡市", prefecture: "静岡県", display: "静岡市" },
};
const ambiguousPlaces = new Set(["静岡"]);
const confirmedTickers: Record<string, { market: string; currency: string }> = {
	AAPL: { market: "NASDAQ", currency: "USD" },
};
const tempNames = { maxTemp: "最高気温", minTemp: "最低気温" } as const;
const iso = "\\d{4}-\\d{2}-\\d{2}";
const temps = "(最高気温 最低気温|最高気温|最低気温)";
const weatherForms: { re: RegExp; pick: (m: RegExpExecArray) => W }[] = [
	{
		re: new RegExp(`^天気予報 (\\S+?)(?: (今日|明日|${iso}))?(?: ${temps})?$`),
		pick: (m) => ({ loc: m[1]!, day: m[2], temps: m[3] }),
	},
	{
		re: /^(\S+?)の天気(?:を教えて)?$/,
		pick: (m) => ({ loc: m[1]! }),
	},
	{
		re: new RegExp(`^(\\S+?) (今日|明日)?の天気(?: ${temps})?$`),
		pick: (m) => ({ loc: m[1]!, day: m[2], temps: m[3] }),
	},
	{
		re: new RegExp(`^(\\S+?) (${iso}) の天気$`),
		pick: (m) => ({ loc: m[1]!, day: m[2] }),
	},
];
type W = { loc: string; day?: string | undefined; temps?: string | undefined };
const quoteForms: RegExp[] = [
	/^株価 ([A-Z0-9.^-]{1,16})(?: (NASDAQ))?(?: (USD))?$/,
	/^([A-Z0-9.^-]{1,16})の株価(?:を教えて)?$/,
];

const normalize = (s: string) =>
	s.normalize("NFKC").trim().replace(/\s+/g, " ");
const validDate = (v: string) => {
	const d = new Date(`${v}T00:00:00Z`);
	return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
};

/** Fixed renderer: every equivalent phrasing produces the same lookup query and key. */
export function renderKeywords(spec: SearchSpec): string {
	if (spec.purpose === "quote") {
		const t = spec.target;
		return `株価 ${t.ticker} ${t.market} ${t.currency} ${t.priceKind}`;
	}
	const display =
		Object.values(places).find((p) => p.name === spec.target.name)?.display ??
		spec.target.name;
	const parts = ["天気予報", display];
	if (spec.timeMode === "tomorrow") parts.push("明日");
	if (spec.timeMode === "absolute") parts.push(spec.absoluteDate!);
	for (const f of spec.requiredFields)
		if (f !== "condition") parts.push(tempNames[f]);
	return parts.join(" ");
}

export const specKey = (spec: SearchSpec) => sha256(canonicalJson(spec));

function finish(spec: SearchSpec): BuiltSpec {
	const withKeywords = {
		...spec,
		keywords: renderKeywords(spec),
	} as SearchSpec;
	const parsed = searchSpec.safeParse(withKeywords);
	if (!parsed.success) return { kind: "unsupported", reason: "spec_invalid" };
	const canonical = canonicalJson(parsed.data);
	return {
		kind: "matched",
		spec: parsed.data,
		key: sha256(canonical),
		canonicalJson: canonical,
	};
}

/** Pure, whole-input grammar. Never deletes characters to force a match. */
export function buildSearchSpec(question: string): BuiltSpec {
	const text = normalize(question);
	if (!text || text.length > 200)
		return { kind: "unsupported", reason: "shape" };
	for (const form of weatherForms) {
		const m = form.re.exec(text);
		if (!m) continue;
		const w = form.pick(m);
		if (ambiguousPlaces.has(w.loc))
			return { kind: "ambiguous", reason: "place_granularity" };
		const place = places[w.loc];
		if (!place) return { kind: "unsupported", reason: "unknown_place" };
		const day = w.day ?? "今日";
		if (/^\d/.test(day) && !validDate(day))
			return { kind: "unsupported", reason: "invalid_date" };
		const fields: WeatherSpec["requiredFields"] = ["condition"];
		if (w.temps?.includes("最高気温")) fields.push("maxTemp");
		if (w.temps?.includes("最低気温")) fields.push("minTemp");
		const spec: WeatherSpec = {
			keyVersion,
			keywords: "x",
			scope: "local:owner",
			language: "ja",
			region: "JP",
			timeZone: "Asia/Tokyo",
			purpose: "weather",
			target: {
				name: place.name,
				prefecture: place.prefecture,
				granularity: "city",
			},
			requiredFields: fields,
			timeMode: /^\d/.test(day)
				? "absolute"
				: day === "明日"
					? "tomorrow"
					: "today",
			...(/^\d/.test(day) ? { absoluteDate: day } : {}),
		};
		return finish(spec);
	}
	for (const re of quoteForms) {
		const m = re.exec(text);
		if (!m) continue;
		const known = confirmedTickers[m[1]!];
		if (!known) return { kind: "unsupported", reason: "unconfirmed_ticker" };
		const spec: QuoteSpec = {
			keyVersion,
			keywords: "x",
			scope: "local:owner",
			language: "en",
			region: "US",
			timeZone: "America/New_York",
			purpose: "quote",
			target: {
				ticker: m[1]!,
				market: known.market,
				currency: known.currency,
				priceKind: "regular",
			},
			requiredFields: [...quoteFields],
			timeMode: "latest",
		};
		return finish(spec);
	}
	return { kind: "unsupported", reason: "shape" };
}

const jstDate = (ms: number) =>
	new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);

/** Resolve relative dates once at request acceptance (Asia/Tokyo for weather). */
export function bindRequest(
	spec: SearchSpec,
	requestAtMs: number,
): RequestBinding {
	let expectedDate: string | null = null;
	if (spec.purpose === "weather") {
		expectedDate =
			spec.timeMode === "absolute"
				? spec.absoluteDate!
				: jstDate(
						requestAtMs + (spec.timeMode === "tomorrow" ? 86_400_000 : 0),
					);
	}
	return {
		specDigest: specKey(spec),
		requestAtMs,
		expectedDate,
		validationPolicyVersion,
	};
}
