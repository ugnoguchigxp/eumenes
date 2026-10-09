type EvidenceReport = {
	claims: Array<{ text: string; evidence: Array<{ quote: string }> }>;
};
/** Forecast pages also print month/day dates such as 10/10(Sat). */
export function checkLiveForecastDate(
	requestedDate: string,
	report: (EvidenceReport & { summary: string }) | null,
) {
	if (!report || !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) return false;
	const [year, month, day] = requestedDate.split("-");
	const pattern = new RegExp(
		`${requestedDate}|${year}年${Number(month)}月${Number(day)}日|${Number(month)}月${Number(day)}日|(?:^|[^\\d/])0?${Number(month)}/0?${Number(day)}(?![\\d/])`,
	);
	return (
		pattern.test(
			[report.summary, ...report.claims.map((c) => c.text)].join("\n"),
		) &&
		pattern.test(
			report.claims.flatMap((c) => c.evidence.map((e) => e.quote)).join("\n"),
		)
	);
}
const amount = (text: string) =>
	Number(
		text.includes(".")
			? text.replaceAll(",", "")
			: /^[-+]?\d{1,3}(,\d{3})+$/.test(text)
				? text.replaceAll(",", "")
				: text.replace(",", "."),
	);
function values(text: string, kind: "weather" | "stock") {
	const units = kind === "stock" ? "(?:USD|米ドル|ドル)" : "(?:℃|°C|度)";
	const patterns = [
		new RegExp(`([-+]?\\d[\\d,]*(?:\\.\\d+)?)\\s*${units}`, "g"),
		new RegExp(`${units}\\s*([-+]?\\d[\\d,]*(?:\\.\\d+)?)`, "g"),
	];
	return patterns
		.flatMap((pattern) => [...text.matchAll(pattern)].map((m) => amount(m[1]!)))
		.filter(Number.isFinite);
}
/** Verify a live answer's numbers against observed quotes, not merely the presence of a number. */
export function checkLiveResearch(
	kind: "weather" | "stock",
	report: EvidenceReport | null,
	answer: string | undefined,
) {
	const claims = report?.claims ?? [];
	const relevant =
		kind === "weather" ? claims.filter((c) => c.text.includes("最高")) : claims;
	const quotes = relevant
		.flatMap((c) => c.evidence.map((e) => e.quote))
		.join("\n");
	const observed =
		kind === "stock"
			? [...quotes.matchAll(/"regularMarketPrice":\s*(\d+(?:\.\d+)?)/g)].map(
					(m) => Number(m[1]),
				)
			: [...quotes.matchAll(/[-+]?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
	const claimed = relevant.flatMap((c) => values(c.text, kind));
	const sourced = claimed.filter((v) => observed.includes(v));
	const answered = values(answer ?? "", kind);
	const valuesMatch =
		claimed.length > 0 &&
		claimed.every((v) => observed.includes(v)) &&
		answered.length > 0 &&
		answered.every((v) => sourced.includes(v));
	const stockDate = claims
		.flatMap((c) => c.evidence.map((e) => e.quote))
		.join("\n")
		.match(/"priceTimeAtExchange":"(\d{4})-(\d{2})-(\d{2})/)
		?.slice(1);
	const priceTimeVerified =
		kind !== "stock" ||
		(!!stockDate &&
			!!answer &&
			(answer.includes(stockDate.join("-")) ||
				new RegExp(
					`(?:${stockDate[0]}|${stockDate[0]!.slice(2)})年(?:${stockDate[1]}|${Number(stockDate[1])})月(?:${stockDate[2]}|${Number(stockDate[2])})日`,
				).test(answer)));
	return { numeric: claimed.length > 0, valuesMatch, priceTimeVerified };
}
