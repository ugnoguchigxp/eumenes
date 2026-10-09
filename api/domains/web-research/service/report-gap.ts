/** A page's existence is not an answer to a request for today's or tomorrow's weather. */
export function shortForecastReportGap(
	question: string,
	report: {
		claims: Array<{ text: string; evidence: Array<{ quote: string }> }>;
	},
) {
	if (!/(今日|明日)/.test(question) || !/(天気|天候|予報)/.test(question))
		return null;
	const condition = /晴|曇|くもり|雨|雪|雷/;
	if (
		!report.claims.some(
			(c) =>
				condition.test(c.text) &&
				c.evidence.some((e) => condition.test(e.quote)),
		)
	)
		return "weather_condition_missing";
	if (
		/最高/.test(question) &&
		!report.claims.some((c) => /最高/.test(c.text) && /\d/.test(c.text))
	)
		return "weather_high_missing";
	return null;
}
