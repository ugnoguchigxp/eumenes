import { bytes } from "../../capabilities";
import type { Source } from "../../tool-runtime";
import { workerSchema, type Report } from "../contracts";
import { evidenceExcerpts } from "./evidence-excerpts";
import {
	ValidationFailure,
	validationIssues,
} from "../../../infrastructure/validation-log";
export function verifyReport(
	raw: unknown,
	visible: Source[],
	hasFailures: boolean,
): Report {
	const result = workerSchema.options[1].shape.report.safeParse(raw);
	if (!result.success)
		throw new ValidationFailure(
			"invalid_report",
			validationIssues(result.error, raw, ["report"]),
			result.error.issues.length,
		);
	const sources = new Map(visible.map((s) => [s.sourceId, s]));
	const used = new Set<string>();
	const claims = result.data.claims.map((claim, claimIndex) => ({
		...claim,
		evidence: claim.evidence.map((evidence, evidenceIndex) => {
			const source = sources.get(evidence.sourceId);
			const referenced = "excerptId" in evidence;
			const quote = referenced
				? source &&
					evidenceExcerpts(source.body).find(
						(e) => e.excerptId === evidence.excerptId,
					)?.quote
				: evidence.quote.replaceAll("\r\n", "\n");
			if (!source || !quote || !source.body.includes(quote))
				throw new ValidationFailure("invalid_evidence", [
					{
						validationPath: `report.claims.${claimIndex}.evidence.${evidenceIndex}.${source ? (referenced ? "excerptId" : "quote") : "sourceId"}`,
						validationCode: source
							? referenced
								? "unknown_excerpt"
								: "quote_mismatch"
							: "unknown_source",
					},
				]);
			used.add(source.sourceId);
			return { sourceId: source.sourceId, quote };
		}),
	}));
	const metadata = [...used].map((id) => {
		const { body: _body, ...source } = sources.get(id)!;
		return source;
	});
	const report: Report = {
		...result.data,
		claims,
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
