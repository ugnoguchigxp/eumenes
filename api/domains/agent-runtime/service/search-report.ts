import type { Database } from "bun:sqlite";
import { hash } from "../../capabilities";
import type { ToolRuntime } from "../../tool-runtime";
import type { Task } from "../contracts";
import type { SearchReportHook } from "./runtime-context";
import type { z } from "zod";
import type { searchReport } from "./research-contract";
import type { EvidenceCatalog } from "./evidence-catalog";
import { owner } from "./runtime-context";
import { verifyReport } from "./verify-report";

/** The search result uses the existing source-linked report, without a model grading phase. */
export function saveSearchReport(
	db: Database,
	task: Task,
	raw: z.infer<typeof searchReport>,
	catalog: EvidenceCatalog,
	tools: ToolRuntime,
	now: number,
	accepted: { hook?: SearchReportHook; packageId?: string } = {},
) {
	// A proposed fetch procedure is not part of the report; the toolchain decides whether to keep it.
	const { recipe, ...findings } = raw;
	const observations = tools.observationsInTransaction(db, task.id);
	const report = verifyReport(
		catalog.report(findings, [
			`確認した操作${tools.invocationsInTransaction(db, task.id).length}件。`,
		]),
		catalog.sources(),
		observations.some((o) => o.state !== "succeeded" || o.failures.length > 0),
		true,
	);
	if (!tools.validateEvidenceInTransaction(db, owner(task), report.sources))
		throw new Error("evidence_invalidated");
	db.query(
		"INSERT INTO agent_reports(task_id,report_json,report_digest,created_at) VALUES(?,?,?,?)",
	).run(task.id, JSON.stringify(report), hash(report), now);
	accepted.hook?.(db, {
		taskId: task.id,
		rootRunId: task.root_run_id,
		packageId: accepted.packageId ?? "",
		report,
		recipe,
	});
}
