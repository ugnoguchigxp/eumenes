import type { Database } from "bun:sqlite";
import {
	hash,
	researchInput,
	type Prepared,
	type Owner,
} from "../../capabilities";
import type { ToolRuntime, Source } from "../../tool-runtime";
import type {
	Task,
	Report,
	StoredBinding,
	AcquisitionPlanPort,
	AcquisitionObservationInput,
} from "../contracts";
import { ValidationFailure } from "../../../infrastructure/validation-log";
import { verifyReport } from "./verify-report";
import { newResearch, isHistory } from "./exploration";
const owner = (t: Task): Owner => ({
	rootRunId: t.root_run_id,
	taskId: t.id,
	cancelEpoch: t.cancel_epoch,
});
const codeOf = (code: string, fallback: string) =>
	/^[a-z_]{1,80}$/.test(code) ? code : fallback;
export function acceptReport(
	db: Database,
	t: Task,
	action: { report: unknown; facts?: unknown },
	input: { visible: Source[] },
	options: {
		tools: ToolRuntime;
		prepared: Prepared | undefined;
		canRead: boolean;
		now: () => number;
		acquisition?: AcquisitionPlanPort;
		reportFeedback?: (question: string, report: Report) => string | null;
		storedBinding: (t: Task) => StoredBinding | null;
		invocationDigests: () => AcquisitionObservationInput["tools"];
	},
) {
	const {
		tools,
		prepared,
		canRead,
		now,
		acquisition,
		reportFeedback,
		storedBinding,
		invocationDigests,
	} = options;
	// Re-resolve all source operations while accepting; expired/cancelled data cannot be adopted.
	const obs = tools.observationsInTransaction(db, t.id);
	const hasFailures = obs.some(
		(o) => o.state !== "succeeded" || o.failures.length > 0,
	);
	let report = verifyReport(
		action.report,
		input.visible,
		hasFailures,
		newResearch(prepared),
	);
	if (
		report.version === 2 &&
		!tools.validateEvidenceInTransaction(db, owner(t), report.sources)
	)
		throw new Error("evidence_invalidated");
	const binding = storedBinding(t);
	// Bound acquisition plans already perform their domain's canonical
	// validation below. This feedback covers the legacy search/read path.
	const gap =
		!binding && !isHistory(prepared) && report.claims.length > 0
			? reportFeedback?.(researchInput.parse(prepared!.input).question, report)
			: null;
	const readUrls = new Set(
		input.visible.filter((s) => s.basis === "page").map((s) => s.url),
	);
	if (
		gap &&
		canRead &&
		input.visible.some((s) => s.basis === "snippet" && !readUrls.has(s.url))
	)
		throw new ValidationFailure("invalid_report", [
			{ validationPath: "report.claims", validationCode: gap },
		]);
	let safe: {
		json: string;
		digest: string;
		binding: string;
	} | null = null;
	if (binding) {
		if (!acquisition) throw new Error("acquisition_unavailable");
		const allowed = acquisition.validateInTransaction(db, {
			bindingToken: binding.bindingToken,
			owner: owner(t),
			stage: "finish",
		});
		if (allowed.kind !== "allowed")
			throw new Error(codeOf(allowed.code, "acquisition_rejected"));
		const result = acquisition.recordObservationInTransaction(db, {
			bindingToken: binding.bindingToken,
			owner: owner(t),
			visibleSources: input.visible.map((s) => ({
				sourceId: s.sourceId,
				url: s.url!,
				body: s.body,
				basis: s.basis,
				fetchedAt: s.fetchedAt,
				truncated: s.truncated,
			})),
			lookupProvenance: binding.lookupProvenance,
			tools: invocationDigests(),
			report,
			facts: action.facts,
		});
		if (result.kind !== "valid")
			throw new Error(
				result.kind === "report_invalid"
					? "invalid_report"
					: result.kind === "source_unusable"
						? "source_unusable"
						: "policy_unavailable",
			);
		// Canonical, host-verified content replaces the model's free text.
		const versionedReport = report;
		report = verifyReport(
			result.canonicalReportPatch,
			input.visible,
			hasFailures,
		);
		if (versionedReport.version)
			report = {
				...report,
				version: 2,
				outcome: versionedReport.outcome,
				exploration: versionedReport.exploration,
			};
		const projection = {
			...result.safeProjection,
			coverage: report.coverage,
			verification: report.verification,
			sources: report.sources.map((s) => ({
				sourceId: s.sourceId,
				url: s.url!,
				basis: s.basis,
				fetchedAt: s.fetchedAt,
			})),
		};
		safe = {
			json: JSON.stringify(projection),
			digest: result.projectionDigest,
			binding: JSON.stringify({
				bindingToken: binding.bindingToken,
				proofId: result.proofId,
			}),
		};
	}
	if (safe)
		db.query(
			"INSERT INTO agent_reports(task_id,report_json,report_digest,created_at,safe_projection_json,safe_projection_digest,acquisition_binding_json) VALUES(?,?,?,?,?,?,?)",
		).run(
			t.id,
			JSON.stringify(report),
			hash(report),
			now(),
			safe.json,
			safe.digest,
			safe.binding,
		);
	else
		db.query(
			"INSERT INTO agent_reports(task_id,report_json,report_digest,created_at) VALUES(?,?,?,?)",
		).run(t.id, JSON.stringify(report), hash(report), now());
}
