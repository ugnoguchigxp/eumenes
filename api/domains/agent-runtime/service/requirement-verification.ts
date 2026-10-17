import { systemContext } from "../../../infrastructure/system-context";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
	bytes,
	hash,
	hashRequirementData,
	canonicalRequirementJson,
	type Capabilities,
} from "../../capabilities";
import type { ToolRuntime } from "../../tool-runtime";
import {
	requirementVerification,
	type RequirementVerification,
} from "../contracts/requirements";
import type { Task, Report } from "../contracts";
import type { LogFields } from "../../../infrastructure/logger";
import { ValidationFailure } from "../../../infrastructure/validation-log";
import { delegatedTaskRules, promptTime } from "../../inference";
import { EvidenceCatalog } from "./evidence-catalog";
import {
	readRequirements,
	readDraft,
	draftReferences,
	validateDraft,
} from "./requirements";
import { verifyReport } from "./verify-report";
const policy =
	systemContext("agent-runtime.contexts.verify-requirements.policy", {}) + "\n";
export function prepareRequirementVerification(
	db: Database,
	task: Task,
	caps: Capabilities,
	tools: ToolRuntime,
	catalog: EvidenceCatalog,
	now: number,
) {
	const frozen = readRequirements(db, task, caps);
	if (!frozen) throw new Error("requirement_verification_unavailable");
	const saved = readDraft(db, task.id, frozen.digest),
		draft = validateDraft(saved.draft, frozen.contract);
	catalog.reconcile(
		tools.observationsInTransaction(db, task.id).flatMap((o) => o.sources),
	);
	const evidence = catalog.verificationEvidence(draftReferences(draft)),
		evidenceManifest = evidence.map(
			({ reference, sourceId, viewId, sourceRevision, viewDigest, quote }) => ({
				reference,
				sourceId,
				viewId,
				sourceRevision,
				viewDigest,
				quoteDigest: hashRequirementData(quote),
			}),
		);
	if (
		!tools.validateEvidenceInTransaction(
			db,
			{
				taskId: task.id,
				rootRunId: task.root_run_id,
				cancelEpoch: task.cancel_epoch,
			},
			catalog.referencedSources(draftReferences(draft)),
		)
	)
		throw new Error("evidence_invalidated");
	const data = {
		originalRequest: frozen.contract.originalRequest,
		question: frozen.contract.question,
		requirementContract: frozen.contract,
		draftReport: draft,
		evidence,
		...promptTime(now),
		// The checks the previous output failed, as data; only paths and codes, never values.
		lastResult:
			task.json_repairs && task.error_code
				? {
						code: task.error_code,
						issues: JSON.parse(task.control_repair_json ?? "[]"),
					}
				: undefined,
		operations: tools.invocationsInTransaction(db, task.id).map((o) => ({
			state: o.state,
			errorCode:
				tools
					.observationsInTransaction(db, task.id)
					.map((o) => ({
						invocationId: o.invocationId,
						code: "errorCode" in o ? o.errorCode : null,
					}))
					.find((r) => r.invocationId === o.id)?.code ?? null,
		})),
	};
	const messages = [
		{
			role: "system" as const,
			content:
				delegatedTaskRules +
				"\n" +
				policy +
				"\nTOOLS=[]\nOUTPUT_SCHEMA=" +
				JSON.stringify(z.toJSONSchema(requirementVerification)),
		},
		{ role: "user" as const, content: JSON.stringify(data) },
	];
	if (task.json_repairs && task.error_code)
		messages.push({
			role: "system",
			content: systemContext(
				"agent-runtime.contexts.requirement-verification.content",
				{},
			),
		});
	if (bytes(messages) > 65536) throw new Error("required_context_overflow");
	return {
		messages,
		visible: catalog.sources(),
		grants: [],
		manifestDigest: hashRequirementData({
			contractDigest: frozen.digest,
			draftDigest: saved.draft_digest,
			evidenceManifest,
		}),
		evidenceManifest,
	};
}
function validateVerification(
	verification: RequirementVerification,
	draft: ReturnType<typeof readDraft>["draft"],
) {
	const exact = (expected: (string | number)[], actual: (string | number)[]) =>
		expected.length === actual.length &&
		new Set(actual).size === actual.length &&
		expected.every((i) => actual.includes(i));
	const mismatch: LogFields[] = [];
	if (
		!exact(
			draft.claims.map((_, i) => i),
			verification.claims.map((c) => c.index),
		)
	)
		mismatch.push({
			validationPath: "claims",
			validationCode: "index_mismatch",
		});
	if (
		!exact(
			draft.checks.map((c) => c.requirementId),
			verification.checks.map((c) => c.requirementId),
		)
	)
		mismatch.push({
			validationPath: "checks",
			validationCode: "requirement_mismatch",
		});
	if (
		!exact(
			draft.externalRules.map((r) => r.id),
			verification.externalRules.map((r) => r.id),
		)
	)
		mismatch.push({
			validationPath: "externalRules",
			validationCode: "rule_mismatch",
		});
	if (mismatch.length)
		throw new ValidationFailure("invalid_requirement_verification", mismatch);
	// Which items failed is reported by position; the judged text is not.
	const failed: LogFields[] = [];
	const flag = (validationPath: string, validationCode: string) =>
		failed.push({ validationPath, validationCode });
	if (!verification.requestCovered) flag("requestCovered", "not_covered");
	if (!verification.summarySupported) flag("summarySupported", "not_supported");
	if (!verification.limitationsConsistent)
		flag("limitationsConsistent", "not_consistent");
	verification.claims.forEach((c, i) => {
		if (!c.supported) flag(`claims.${i}.supported`, "not_supported");
	});
	verification.checks.forEach((c, i) => {
		if (!c.supported) flag(`checks.${i}.supported`, "not_supported");
		if (
			draft.checks.find((d) => d.requirementId === c.requirementId)!.status !==
			c.status
		)
			flag(`checks.${i}.status`, "status_mismatch");
	});
	verification.externalRules.forEach((r, i) => {
		if (!r.supported) flag(`externalRules.${i}.supported`, "not_supported");
	});
	if (failed.length)
		throw new ValidationFailure("requirement_verification_failed", failed);
}
export function acceptRequirementVerification(
	db: Database,
	task: Task,
	caps: Capabilities,
	tools: ToolRuntime,
	catalog: EvidenceCatalog,
	input: { manifestDigest: string; requestId: string },
	verification: RequirementVerification,
	now: number,
): Report {
	const context = prepareRequirementVerification(
		db,
		task,
		caps,
		tools,
		catalog,
		now,
	);
	if (context.manifestDigest !== input.manifestDigest)
		throw new Error("evidence_invalidated");
	const frozen = readRequirements(db, task, caps)!,
		saved = readDraft(db, task.id, frozen.digest),
		draft = saved.draft;
	validateVerification(verification, draft);
	const envelope = {
			contractDigest: frozen.digest,
			draftDigest: saved.draft_digest,
			evidenceManifest: context.evidenceManifest,
			requestId: input.requestId,
			verification,
		},
		verificationDigest = hashRequirementData(envelope);
	const {
		checks: _checks,
		externalRules: _rules,
		...base
	} = catalog.report(draft, [
		`確認した操作${tools.invocationsInTransaction(db, task.id).length}件。`,
	]);
	const hasFailures = tools
		.observationsInTransaction(db, task.id)
		.some((o) => o.state !== "succeeded" || o.failures.length > 0);
	const canonical = verifyReport(base, catalog.sources(), hasFailures, true);
	const requirements = {
		contractDigest: frozen.digest,
		requestDigest: frozen.contract.requestDigest,
		profiles: frozen.contract.profiles.map(
			({ revisionId, hash, generation }) => ({ revisionId, hash, generation }),
		),
		items: frozen.contract.requirements.map(
			({ id, statement, required, applicability, origin }) => ({
				id,
				statement,
				required,
				applicability,
				origin:
					origin.kind === "request" ? { kind: "request" as const } : origin,
			}),
		),
		checks: draft.checks.map((c) => ({
			...c,
			evidence: catalog.canonicalEvidence(c.evidence),
		})),
		externalRules: draft.externalRules.map((r) => ({
			...r,
			evidence: catalog.canonicalEvidence(r.evidence),
		})),
		verificationDigest,
		semanticVerification: "model_checked" as const,
	};
	const sources = catalog
		.referencedSources(draftReferences(draft))
		.map(({ body: _body, ...s }) => s);
	const report: Report = {
		...canonical,
		version: 3,
		outcome: draft.outcome,
		requirements,
		sources,
		coverage:
			canonical.coverage === "partial" ||
			draft.checks.some((c) => ["unknown", "unsatisfied"].includes(c.status)) ||
			sources.some((s) => s.basis === "snippet" || s.acquisitionTruncated)
				? "partial"
				: "complete",
	};
	if (bytes(report) > 32768) throw new Error("report_too_large");
	if (
		!tools.validateEvidenceInTransaction(
			db,
			{
				taskId: task.id,
				rootRunId: task.root_run_id,
				cancelEpoch: task.cancel_epoch,
			},
			sources,
		)
	)
		throw new Error("evidence_invalidated");
	if (
		db
			.query(
				"UPDATE agent_requirement_drafts SET state='accepted',verification_json=?,verification_digest=? WHERE task_id=? AND state='pending'",
			)
			.run(canonicalRequirementJson(envelope), verificationDigest, task.id)
			.changes !== 1
	)
		throw new Error("requirement_verification_failed");
	db.query(
		"INSERT INTO agent_reports(task_id,report_json,report_digest,created_at) VALUES(?,?,?,?)",
	).run(task.id, JSON.stringify(report), hash(report), now);
	return report;
}
export function validateRequirementAdoption(
	db: Database,
	task: Task,
	report: Report,
	caps: Capabilities,
) {
	if (report.version !== 3) return;
	const frozen = readRequirements(db, task, caps);
	if (
		!frozen ||
		frozen.digest !== report.requirements.contractDigest ||
		frozen.contract.requestDigest !== report.requirements.requestDigest
	)
		throw new Error("report_invalidated");
	const saved = readDraft(db, task.id, frozen.digest, "accepted");
	if (
		!saved.verification_json ||
		saved.verification_digest !== report.requirements.verificationDigest
	)
		throw new Error("report_invalidated");
	const envelope = JSON.parse(saved.verification_json);
	if (
		hashRequirementData(envelope) !== saved.verification_digest ||
		envelope.contractDigest !== frozen.digest ||
		envelope.draftDigest !== saved.draft_digest
	)
		throw new Error("report_invalidated");
	validateVerification(
		requirementVerification.parse(envelope.verification),
		saved.draft,
	);
}
