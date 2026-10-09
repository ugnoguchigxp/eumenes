import { bytes } from "../../capabilities";
import type { Source } from "../../tool-runtime";
import { reportSchema, type Report } from "../contracts";
export function verifyReport(
	raw: unknown,
	visible: Source[],
	hasFailures: boolean,
): Report {
	const result = reportSchema.safeParse(raw);
	if (!result.success) throw new Error("invalid_report");
	const sources = new Map(visible.map((s) => [s.sourceId, s]));
	const used = new Set<string>();
	for (const claim of result.data.claims)
		for (const evidence of claim.evidence) {
			const source = sources.get(evidence.sourceId);
			if (
				!source ||
				!source.body.includes(evidence.quote.replaceAll("\r\n", "\n"))
			)
				throw new Error("invalid_evidence");
			used.add(source.sourceId);
		}
	const metadata = [...used].map((id) => {
		const { body: _body, ...source } = sources.get(id)!;
		return source;
	});
	const report: Report = {
		...result.data,
		sources: metadata,
		coverage:
			hasFailures || metadata.some((s) => s.basis === "snippet" || s.truncated)
				? "partial"
				: "complete",
		verification: "evidence_linked",
	};
	if (bytes(report) > 16384) throw new Error("report_too_large");
	return report;
}
/** Only paraphrased facts and host source metadata cross the child → parent boundary. */
export function parentProjection(report: Report) {
	return {
		summary: report.summary,
		claims: report.claims.map((c) => ({
			text: c.text,
			sourceIds: c.evidence.map((e) => e.sourceId),
		})),
		limitations: report.limitations,
		coverage: report.coverage,
		verification: report.verification,
		sources: report.sources.map((s) => ({
			sourceId: s.sourceId,
			url: s.url,
			basis: s.basis,
			fetchedAt: s.fetchedAt,
		})),
	};
}
