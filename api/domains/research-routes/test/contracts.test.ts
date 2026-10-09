import { expect, test } from "bun:test";
import {
	canonicalJson,
	quoteSpec,
	routeFacts,
	searchSpec,
	weatherSpec,
} from "..";

const base = {
	keyVersion: 1,
	scope: "local:owner",
	language: "ja",
	region: "JP",
	timeZone: "Asia/Tokyo",
} as const;
const weather = {
	...base,
	keywords: "天気予報 鎌倉",
	purpose: "weather",
	target: { name: "鎌倉市", prefecture: "神奈川県", granularity: "city" },
	requiredFields: ["condition"],
	timeMode: "today",
};
const quote = {
	...base,
	language: "en",
	region: "US",
	keywords: "株価 AAPL NASDAQ USD regular",
	purpose: "quote",
	target: {
		ticker: "AAPL",
		market: "NASDAQ",
		currency: "USD",
		priceKind: "regular",
	},
	requiredFields: ["asOf", "currency", "market", "price", "priceKind"],
	timeMode: "latest",
};

test("K01 specs accept the frozen shapes and reject type errors", () => {
	expect(searchSpec.safeParse(weather).success).toBe(true);
	expect(searchSpec.safeParse(quote).success).toBe(true);
	expect(weatherSpec.safeParse({ ...weather, extra: 1 }).success).toBe(false);
	expect(
		weatherSpec.safeParse({ ...weather, timeMode: "latest" }).success,
	).toBe(false);
	expect(
		weatherSpec.safeParse({ ...weather, timeMode: "absolute" }).success,
	).toBe(false);
	expect(
		weatherSpec.safeParse({
			...weather,
			timeMode: "absolute",
			absoluteDate: "2026-02-30",
		}).success,
	).toBe(false);
	expect(
		weatherSpec.safeParse({ ...weather, absoluteDate: "2026-10-10" }).success,
	).toBe(false);
	expect(
		weatherSpec.safeParse({
			...weather,
			requiredFields: ["maxTemp", "condition"],
		}).success,
	).toBe(false);
	expect(
		weatherSpec.safeParse({
			...weather,
			requiredFields: ["condition", "condition"],
		}).success,
	).toBe(false);
	expect(
		quoteSpec.safeParse({
			...quote,
			target: { ...quote.target, priceKind: "realtime" },
		}).success,
	).toBe(false);
	expect(quoteSpec.safeParse({ ...quote, timeMode: "today" }).success).toBe(
		false,
	);
	expect(
		weatherSpec.safeParse({ ...weather, keywords: "x".repeat(401) }).success,
	).toBe(false);
});

test("K01 facts reject unknown fields and oversized payloads", () => {
	const facts = {
		purpose: "quote",
		ticker: "AAPL",
		market: "NASDAQ",
		currency: "USD",
		priceKind: "regular",
		price: 190.5,
		priceAt: "2026-10-09T20:00:00Z",
		timeZone: "America/New_York",
		evidence: [{ sourceId: "s1", quote: "AAPL 190.5" }],
	};
	expect(routeFacts.safeParse(facts).success).toBe(true);
	expect(routeFacts.safeParse({ ...facts, extra: 1 }).success).toBe(false);
	expect(
		routeFacts.safeParse({ ...facts, priceKind: "realtime" }).success,
	).toBe(false);
	expect(
		routeFacts.safeParse({
			...facts,
			evidence: [{ sourceId: "s1", quote: "x".repeat(401) }],
		}).success,
	).toBe(false);
});

test("canonicalJson sorts keys but keeps array order", () => {
	expect(canonicalJson({ b: [2, 1], a: { d: 1, c: undefined, b: 2 } })).toBe(
		'{"a":{"b":2,"d":1},"b":[2,1]}',
	);
});
