/** Public structured sources; credentials and arbitrary destinations are never accepted. */
export function publicDataUrl(kind: "forecast" | "quote", value: string) {
	if (kind === "forecast") {
		if (!/^\d{6}$/.test(value)) throw new Error("invalid_forecast_area");
		return `https://www.jma.go.jp/bosai/forecast/data/forecast/${value}.json`;
	}
	if (!/^[A-Z0-9.^-]{1,16}$/.test(value))
		throw new Error("invalid_quote_symbol");
	return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(value)}?interval=1d&range=1d`;
}
export function sourceMatchesQuestion(
	kind: "forecast" | "quote",
	value: string,
	question: string,
) {
	if (kind === "quote")
		return new RegExp(
			`(?:^|[^A-Z0-9.^-])${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^A-Z0-9.^-]|\\.(?:$|[^A-Z0-9.^-]))`,
		).test(question.toUpperCase());
	const areas: Record<string, string[]> = {
		"130000": ["東京", "千代田"],
		"270000": ["大阪"],
		"140000": ["神奈川", "横浜"],
		"260000": ["京都"],
		"230000": ["愛知", "名古屋"],
		"400000": ["福岡"],
		"280000": ["兵庫", "神戸"],
	};
	return (areas[value] ?? []).some((name) => question.includes(name));
}

/** A conservative invocation example, never an execution or permission grant. */
export function publicInvocationHint(question: string) {
	if (/天気|気温|予報/.test(question)) {
		const areas = [
			"130000",
			"270000",
			"140000",
			"260000",
			"230000",
			"400000",
			"280000",
		].filter((area) => sourceMatchesQuestion("forecast", area, question));
		if (areas.length === 1)
			return { toolId: "web.forecast", arguments: { areaCode: areas[0]! } };
	}
	if (/株価|stock|quote|price/i.test(question)) {
		const symbols = [
			...new Set(question.match(/(?:\^|\b)[A-Z0-9][A-Z0-9.^-]{0,15}\b/g) ?? []),
		].filter(
			(symbol) =>
				!["NASDAQ", "NYSE", "TYO", "USD", "JPY", "ETF"].includes(symbol) &&
				/[A-Z]/.test(symbol),
		);
		if (symbols.length === 1)
			return { toolId: "web.quote", arguments: { symbol: symbols[0]! } };
	}
	return null;
}
