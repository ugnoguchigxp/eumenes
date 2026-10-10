import { z } from "zod";
import {
	canonicalJson,
	routeFacts,
	sha256,
	ttl,
	validationPolicyVersion,
	type RequestBinding,
	type RouteFacts,
	type SearchSpec,
	type VisibleSource,
	weatherConditions,
} from "../contracts";
import { specKey } from "./keys";

export type CheckResult =
	| {
			kind: "valid";
			facts: RouteFacts;
			sourceId: string;
			url: string;
			fetchedAt: string;
			factsDigest: string;
	  }
	| { kind: "source_unusable"; code: string }
	| { kind: "report_invalid"; code: string }
	| { kind: "policy_unavailable"; code: string };
export type CheckInput = {
	spec: SearchSpec;
	binding: RequestBinding;
	sources: VisibleSource[];
	facts: unknown;
	reportEvidence?: Array<{ sourceId: string; quote: string }>;
	now: number;
};
type Condition = (typeof weatherConditions)[number];
type Extraction =
	| { ok: true; facts: RouteFacts; tokens: string[] }
	| { ok: false; code: string };

const ws = (s: string) => s.replace(/\s+/g, " ").trim();
const fail = (code: string): Extraction => ({ ok: false, code });
const conditionLabels: Record<string, Condition> = {
	晴れ: "clear",
	晴: "clear",
	快晴: "clear",
	曇り: "cloudy",
	曇: "cloudy",
	くもり: "cloudy",
	雨: "rain",
	小雨: "rain",
	雪: "snow",
	雷: "thunder",
	雷雨: "thunder",
	霧: "fog",
};

function extractQuote(
	spec: Extract<SearchSpec, { purpose: "quote" }>,
	source: VisibleSource,
	now: number,
): Extraction {
	const json = source.body.split("\n")[1];
	if (!json) return fail("no_data");
	const parsed = z
		.object({
			symbol: z.string(),
			currency: z.string(),
			regularMarketPrice: z.number().finite().positive(),
			exchangeTimezoneName: z.string().max(100),
			market: z.string().optional(),
			priceTimeUtc: z.string().datetime(),
			priceBasis: z.string().optional(),
		})
		.safeParse(safeJson(json));
	if (!parsed.success) return fail("format_unrecognized");
	const q = parsed.data;
	if (!q.market) return fail("market_unverified");
	const t = spec.target;
	if (
		q.symbol !== t.ticker ||
		q.market !== t.market ||
		q.currency !== t.currency
	)
		return fail("target_mismatch");
	if (!q.priceBasis?.startsWith("regularMarketPrice"))
		return fail("price_kind_unverified");
	const at = Date.parse(q.priceTimeUtc);
	if (at > now + ttl.futureSkewMs) return fail("time_in_future");
	if (now - at > ttl.quoteFreshMs) return fail("stale");
	return {
		ok: true,
		facts: {
			purpose: "quote",
			ticker: q.symbol,
			market: q.market,
			currency: q.currency,
			priceKind: "regular",
			price: q.regularMarketPrice,
			priceAt: q.priceTimeUtc,
			timeZone: q.exchangeTimezoneName,
			evidence: [],
		},
		tokens: [
			`"symbol":"${q.symbol}"`,
			`"regularMarketPrice":${q.regularMarketPrice}`,
			`"currency":"${q.currency}"`,
			`"market":"${q.market}"`,
			`"priceTimeUtc":"${q.priceTimeUtc}"`,
		],
	};
}
const safeJson = (s: string): unknown => {
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
};

const weatherLine =
	/^(\S+) (\d{4}-\d{2}-\d{2}) 天気 (\S+)(?: 最高気温 (-?\d+))?(?: 最低気温 (-?\d+))? 発表 (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))$/;
function extractWeather(
	spec: Extract<SearchSpec, { purpose: "weather" }>,
	binding: RequestBinding,
	source: VisibleSource,
	now: number,
): Extraction {
	if (source.body.startsWith("気象庁公開JSON"))
		return fail("granularity_unsupported");
	const lines = source.body
		.split("\n")
		.map(ws)
		.filter((l) => weatherLine.test(l));
	if (!lines.length) return fail("format_unrecognized");
	const rows = lines.map((l) => weatherLine.exec(l)!);
	const here = rows.filter((m) => m[1] === spec.target.name);
	if (!here.length) return fail("location_mismatch");
	const day = here.filter((m) => m[2] === binding.expectedDate);
	if (!day.length) return fail("date_mismatch");
	const first = day[0]!;
	if (
		day.some(
			(m) =>
				m[0]!.replace(/ 発表 .*/, "") !== first[0]!.replace(/ 発表 .*/, ""),
		)
	)
		return fail("conflicting_values");
	const condition = conditionLabels[first[3]!];
	if (!condition) return fail("condition_unmapped");
	const need = (f: "maxTemp" | "minTemp") => spec.requiredFields.includes(f);
	if (
		(need("maxTemp") && first[4] === undefined) ||
		(need("minTemp") && first[5] === undefined)
	)
		return fail("field_missing");
	const announced = Date.parse(first[6]!);
	if (Number.isNaN(announced)) return fail("announce_unparsable");
	// Only the host's own re-rendering of the instant ever reaches facts/projection.
	const announcedIso = new Date(announced).toISOString();
	if (announced > now + ttl.futureSkewMs) return fail("time_in_future");
	if (now - announced > ttl.weatherFreshMs) return fail("stale");
	const facts: RouteFacts = {
		purpose: "weather",
		location: spec.target,
		targetDate: first[2]!,
		timeZone: spec.timeZone,
		condition,
		...(need("maxTemp") ? { maxTemp: Number(first[4]) } : {}),
		...(need("minTemp") ? { minTemp: Number(first[5]) } : {}),
		unit: "C",
		announcedAt: announcedIso,
		evidence: [],
	};
	// The whole normalized line is the evidence window: label, date, value and announcement together.
	return { ok: true, facts, tokens: [ws(first[0]!)] };
}

/** Independent host extraction from one visible source. */
export function extractFromSource(
	spec: SearchSpec,
	binding: RequestBinding,
	source: VisibleSource,
	now: number,
): Extraction {
	if (source.basis !== "page") return fail("snippet_only");
	if (source.truncated) return fail("truncated");
	return spec.purpose === "quote"
		? extractQuote(spec, source, now)
		: extractWeather(spec, binding, source, now);
}

const sameValues = (a: RouteFacts, b: RouteFacts) => {
	const strip = (f: RouteFacts) => {
		const { evidence: _e, ...rest } = f;
		return rest;
	};
	const x = strip(a) as Record<string, unknown>,
		y = strip(b) as Record<string, unknown>;
	for (const k of ["announcedAt", "priceAt"])
		if (typeof x[k] === "string" && typeof y[k] === "string") {
			if (Date.parse(x[k]) !== Date.parse(y[k])) return false;
			x[k] = y[k] = "t";
		}
	return canonicalJson(x) === canonicalJson(y);
};

/**
 * Compare the child's facts with an independent extraction. Source problems (re-search)
 * and report problems (fix/retry) are different results by contract.
 */
export function checkObservation(input: CheckInput): CheckResult {
	const { spec, binding, sources, now } = input;
	if (binding.validationPolicyVersion !== validationPolicyVersion)
		return { kind: "policy_unavailable", code: "policy_unknown" };
	if (binding.specDigest !== specKey(spec))
		return { kind: "policy_unavailable", code: "binding_mismatch" };
	const reported = routeFacts.safeParse(input.facts);
	const derive =
		input.facts === undefined && input.reportEvidence !== undefined;
	if (!reported.success && !derive)
		return { kind: "report_invalid", code: "facts_schema" };
	const byId = new Map(sources.map((s) => [s.sourceId, s]));
	const evidence = reported.success
		? reported.data.evidence
		: (input.reportEvidence ?? []);
	if (evidence.some((e) => !byId.has(e.sourceId)))
		return { kind: "report_invalid", code: "evidence_source_missing" };
	if (!sources.length) return { kind: "source_unusable", code: "no_sources" };
	const found: { source: VisibleSource; ex: Extraction & { ok: true } }[] = [];
	let firstFail = "no_data";
	for (const source of sources) {
		const ex = extractFromSource(spec, binding, source, now);
		if (ex.ok) found.push({ source, ex });
		else if (found.length === 0 && firstFail === "no_data") firstFail = ex.code;
	}
	if (!found.length) return { kind: "source_unusable", code: firstFail };
	const base = found[0]!;
	if (found.some((f) => !sameValues(f.ex.facts, base.ex.facts)))
		return { kind: "source_unusable", code: "conflicting_values" };
	const ids = new Set(evidence.map((e) => e.sourceId));
	const chosen = found.find((f) => ids.has(f.source.sourceId)) ?? base;
	if (reported.success && !sameValues(chosen.ex.facts, reported.data))
		return { kind: "report_invalid", code: "facts_mismatch" };
	const body = ws(chosen.source.body);
	const good = evidence.filter(
		(e) =>
			e.sourceId === chosen.source.sourceId &&
			ws(e.quote).length > 0 &&
			body.includes(ws(e.quote)),
	);
	const quoted = good.map((e) => ws(e.quote)).join(" ");
	if (!good.length || !chosen.ex.tokens.every((t) => quoted.includes(t)))
		return { kind: "report_invalid", code: "evidence_missing" };
	const facts = { ...chosen.ex.facts, evidence: good } as RouteFacts;
	return {
		kind: "valid",
		facts,
		sourceId: chosen.source.sourceId,
		url: chosen.source.url,
		fetchedAt: chosen.source.fetchedAt,
		factsDigest: sha256(canonicalJson(facts)),
	};
}
