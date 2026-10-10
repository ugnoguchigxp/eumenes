import { readFileSync } from "node:fs";
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
import { EvidenceCatalog } from "./evidence-catalog";
import {
	readRequirements,
	readDraft,
	draftReferences,
	validateDraft,
} from "./requirements";
import { verifyReport } from "./verify-report";
const policy = readFileSync(
	new URL("../prompts/verify-requirements.md", import.meta.url),
	"utf8",
);
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
		now: new Date(now).toISOString(),
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
				policy +
				"\nTOOLS=[]\nOUTPUT_SCHEMA=" +
				JSON.stringify(z.toJSONSchema(requirementVerification)),
		},
		{ role: "user" as const, content: JSON.stringify(data) },
	];
	if (task.json_repairs && task.error_code)
		messages.push({
			role: "system",
			content:
				"前回の構造違反を固定schemaで一度だけ修正します。条件・報告候補を変えません。",
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
export function validateVerification(
	verification: RequirementVerification,
	draft: ReturnType<typeof readDraft>["draft"],
) {
	const exact = (expected: (string | number)[], actual: (string | number)[]) =>
		expected.length === actual.length &&
		new Set(actual).size === actual.length &&
		expected.every((i) => actual.includes(i));
	if (
		!exact(
			draft.claims.map((_, i) => i),
			verification.claims.map((c) => c.index),
		) ||
		!exact(
			draft.checks.map((c) => c.requirementId),
			verification.checks.map((c) => c.requirementId),
		) ||
		!exact(
			draft.externalRules.map((r) => r.id),
			verification.externalRules.map((r) => r.id),
		)
	)
		throw new Error("invalid_requirement_verification");
	if (
		!verification.requestCovered ||
		!verification.summarySupported ||
		!verification.limitationsConsistent ||
		[
			...verification.claims,
			...verification.checks,
			...verification.externalRules,
		].some((c) => !c.supported) ||
		verification.checks.some(
			(c) =>
				draft.checks.find((d) => d.requirementId === c.requirementId)!
					.status !== c.status,
		)
	)
		throw new Error("requirement_verification_failed");
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
