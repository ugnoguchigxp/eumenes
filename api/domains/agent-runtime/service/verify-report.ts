import { bytes } from "../../capabilities";
import type { Source } from "../../tool-runtime";
import {
	reportV2Schema,
	legacyWorkerReportSchema,
	type Report,
} from "../contracts";
import { evidenceExcerpts } from "./evidence-excerpts";
import {
	ValidationFailure,
	validationIssues,
} from "../../../infrastructure/validation-log";
export function verifyReport(
	raw: unknown,
	visible: Source[],
	hasFailures: boolean,
	requireViews = false,
): Report {
	const result = (
		raw && typeof raw === "object" && "version" in raw
			? reportV2Schema
			: legacyWorkerReportSchema
	).safeParse(raw);
	if (!result.success)
		throw new ValidationFailure(
			"invalid_report",
			validationIssues(result.error, raw, ["report"]),
			result.error.issues.length,
		);
	if (requireViews && !("version" in result.data))
		throw new Error("invalid_report");
	const sources = new Map(
		visible.map((s) => [s.sourceId + ":" + (s.viewId ?? ""), s]),
	);
	const used = new Set<string>();
	const claims = result.data.claims.map((claim, claimIndex) => ({
		...claim,
		evidence: claim.evidence.map((evidence, evidenceIndex) => {
			const viewId = "viewId" in evidence ? evidence.viewId : undefined;
			const source = viewId
				? sources.get(evidence.sourceId + ":" + viewId)
				: visible.find((s) => s.sourceId === evidence.sourceId);
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
						validationPath: `report.claims.${claimIndex}.evidence.${evidenceIndex}.${source ? (referenced ? "excerptId" : "quote") : viewId ? "viewId" : "sourceId"}`,
						validationCode: source
							? referenced
								? "unknown_excerpt"
								: "quote_mismatch"
							: viewId
								? "unknown_view"
								: "unknown_source",
					},
				]);
			used.add(source.sourceId + ":" + (source.viewId ?? ""));
			return {
				sourceId: source.sourceId,
				quote: source.kind === "conversation_source" ? "" : quote,
				...(viewId ? { viewId } : {}),
			};
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
			hasFailures ||
			("outcome" in result.data && result.data.outcome !== "answered") ||
			metadata.some(
				(s) =>
					s.basis === "snippet" ||
					s.acquisitionTruncated ||
					(!s.viewId && s.truncated),
			)
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
		...(report.version === 3
			? {
					requirements: {
						items: report.requirements.items,
						checks: report.requirements.checks.map(({ evidence, ...c }) => ({
							...c,
							sourceIds: evidence.map((e) => e.sourceId),
						})),
						externalRules: report.requirements.externalRules.map(
							({ evidence, ...r }) => ({
								...r,
								sourceIds: evidence.map((e) => e.sourceId),
							}),
						),
						semanticVerification: report.requirements.semanticVerification,
					},
				}
			: {}),
		...(report.version
			? {
					version: report.version,
					outcome: report.outcome,
					exploration: report.exploration,
				}
			: {}),
		claims: report.claims.map((c) => ({
			text: c.text,
			sourceIds: c.evidence.map((e) => e.sourceId),
		})),
		limitations: report.limitations,
		coverage: report.coverage,
		verification: report.verification,
		sources: report.sources.map((s) =>
			s.kind === "conversation_source"
				? {
						sourceId: s.sourceId,
						kind: s.kind,
						messageId: s.messageId,
						speaker: s.speaker,
						createdAt: s.createdAt,
						revision: s.revision,
					}
				: {
						sourceId: s.sourceId,
						url: s.url,
						basis: s.basis,
						fetchedAt: s.fetchedAt,
					},
		),
	};
}

export function isNegativeReport(report: Report | null) {
	return (
		(report?.version === 2 || report?.version === 3) &&
		report.claims.length === 0 &&
		["not_found", "clarification_required", "failed"].includes(
			report.outcome ?? "",
		)
	);
}
