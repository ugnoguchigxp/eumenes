import type { Database } from "bun:sqlite";
import { hash, bytes } from "../../capabilities";
import type { ToolRuntime } from "../../tool-runtime";
import type { Task } from "../contracts";
import type { EvidenceCatalog } from "./evidence-catalog";
import type { GuidedReport } from "./guided-contract";
import { owner } from "./runtime-context";
import type { SearchReportHook } from "./runtime-context";
import { parentProjection, verifyReport } from "./verify-report";

/** Completion is a response judgement; certainty is retained per requested fact. */
export function saveGuidedReport(
	db: Database,
	task: Task,
	raw: GuidedReport,
	catalog: EvidenceCatalog,
	tools: ToolRuntime,
	now: number,
	accepted: { hook?: SearchReportHook; packageId?: string } = {},
) {
	const candidateResults = catalog.candidates.results(raw.candidateRefs ?? []);
	const claims = raw.claims
		.filter((c) => c.evidence.length > 0)
		.map(({ text, evidence }) => ({ text, evidence }));
	catalog.checkPlaced("claims", raw.claims);
	const refs = raw.claims.flatMap((c) => c.evidence);
	if (catalog.referencedSources(refs).some((s) => s.basis !== "page" || !s.url))
		throw new Error("invalid_evidence");
	const baseReport = verifyReport(
		catalog.report(
			{
				outcome: claims.length
					? raw.completion === "complete" &&
						raw.claims.every((c) => c.status === "verified")
						? "answered"
						: "partial"
					: "not_found",
				summary: raw.summary,
				claims,
				limitations: raw.limitations,
			},
			[`確認した操作${tools.invocationsInTransaction(db, task.id).length}件。`],
		),
		catalog.sources(),
		tools
			.observationsInTransaction(db, task.id)
			.some((o) => o.state !== "succeeded" || o.failures.length > 0),
		true,
		true,
	);
	const candidateSources = (raw.candidateRefs ?? []).map((ref) => {
		const { body: _body, ...metadata } = catalog.candidates.source(ref);
		return metadata;
	});
	if (!tools.validateEvidenceInTransaction(db, owner(task), candidateSources))
		throw new Error("candidate_invalidated");
	const report = {
		...baseReport,
		...(candidateResults.length
			? {
					candidateResults,
					outcome: !claims.length
						? ("candidates_found" as const)
						: baseReport.outcome,
					sources: [
						...baseReport.sources,
						...candidateSources.filter(
							(s) => !baseReport.sources.some((b) => b.sourceId === s.sourceId),
						),
					],
				}
			: {}),
	};
	if (bytes(report) > 16384) throw new Error("report_too_large");
	if (!tools.validateEvidenceInTransaction(db, owner(task), report.sources))
		throw new Error("evidence_invalidated");
	const projection = {
		...parentProjection(report),
		delivery: "guided-web",
		answer: candidateResults.length
			? `${raw.answer}\n\n${candidateResults.map((c) => `- [${c.title.replace(/[[\]\\]/g, "")}](<${c.url}>)（本文未確認）`).join("\n")}`
			: raw.answer,
		...(candidateResults.length
			? { candidateResults, outcome: report.outcome }
			: {}),
		completion: raw.completion,
		factStates: raw.claims.map(({ text, status }) => ({ text, status })),
	};
	db.query(
		"INSERT INTO agent_reports(task_id,report_json,report_digest,created_at,safe_projection_json,safe_projection_digest) VALUES(?,?,?,?,?,?)",
	).run(
		task.id,
		JSON.stringify(report),
		hash(report),
		now,
		JSON.stringify(projection),
		hash(projection),
	);
	accepted.hook?.(db, {
		taskId: task.id,
		rootRunId: task.root_run_id,
		packageId: accepted.packageId ?? "",
		report,
		recipe: raw.recipe,
	});
}
