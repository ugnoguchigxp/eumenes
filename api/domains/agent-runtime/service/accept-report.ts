import type { Database } from "bun:sqlite";
import { hash, type Owner } from "../../capabilities";
import type { ToolRuntime, Source } from "../../tool-runtime";
import type {
	Task,
	StoredBinding,
	AcquisitionPlanPort,
	AcquisitionObservationInput,
} from "../contracts";
import { verifyReport } from "./verify-report";
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
	action: { report: unknown },
	input: { visible: Source[] },
	options: {
		tools: ToolRuntime;
		now: () => number;
		acquisition?: AcquisitionPlanPort;
		storedBinding: (t: Task) => StoredBinding | null;
		invocationDigests: () => AcquisitionObservationInput["tools"];
	},
) {
	const { tools, now, acquisition, storedBinding, invocationDigests } = options;
	// Re-resolve all source operations while accepting; expired/cancelled data cannot be adopted.
	const obs = tools.observationsInTransaction(db, t.id);
	const hasFailures = obs.some(
		(o) => o.state !== "succeeded" || o.failures.length > 0,
	);
	let report = verifyReport(action.report, input.visible, hasFailures, true);
	if (
		report.version === 2 &&
		!tools.validateEvidenceInTransaction(db, owner(t), report.sources)
	)
		throw new Error("evidence_invalidated");
	const binding = storedBinding(t);
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
		if (report.claims.length) {
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
				version: report.version,
				outcome: report.outcome,
				exploration: report.exploration,
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
