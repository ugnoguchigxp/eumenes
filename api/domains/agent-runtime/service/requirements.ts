import type { Database } from "bun:sqlite";
import {
	bytes,
	canonicalRequirementJson,
	hashRequirementData,
	validateRequirementSchema,
	requirementValueMatches,
	type ProfileSnapshot,
	type Capabilities,
} from "../../capabilities";
import {
	requirementContract,
	draftReport,
	type RequirementContract,
	type RequestRequirement,
	type DraftReport,
} from "../contracts/requirements";
import type { Task } from "../contracts";
export function freezeRequirements(
	db: Database,
	task: Task,
	requests: RequestRequirement[],
	capabilities: Capabilities,
	now: number,
) {
	const input = JSON.parse(task.input_json ?? "{}");
	const profiles = (input.requirementProfiles ?? []) as ProfileSnapshot[];
	capabilities.validateRequirementProfilesInTransaction(db, profiles);
	profiles.sort((a, b) => a.revisionId.localeCompare(b.revisionId));
	const originalRequest = input.originalRequest ?? input.question,
		question = input.question;
	if (
		!requests.length ||
		requests.length +
			profiles.reduce((n, p) => n + p.data.requirements.length, 0) >
			12
	)
		throw new Error("requirement_capacity_exceeded");
	requests.forEach((r, i) => {
		if (r.id !== `r${i + 1}` || !originalRequest.includes(r.requestQuote))
			throw new Error("invalid_requirement_contract");
		validateRequirementSchema(r.valueSchema);
	});
	const requirements = [
		...requests.map((r) => ({
			id: r.id,
			statement: r.statement,
			required: true,
			allowNotApplicable: false,
			applicability: "現在の依頼",
			valueSchema: r.valueSchema,
			origin: { kind: "request" as const, requestQuote: r.requestQuote },
		})),
		...profiles.flatMap((p, i) =>
			p.data.requirements.map((r) => ({
				...r,
				id: `p${i + 1}.${r.id}`,
				origin: {
					kind: "profile" as const,
					revisionId: p.revisionId,
					localId: r.id,
				},
			})),
		),
	];
	for (const r of requirements) validateRequirementSchema(r.valueSchema);
	const requestDigest = hashRequirementData({
		originalRequest,
		question,
		taskId: task.id,
		rootRunId: task.root_run_id,
		cancelEpoch: task.cancel_epoch,
		profiles: profiles.map(({ revisionId, hash, generation }) => ({
			revisionId,
			hash,
			generation,
		})),
	});
	const contract = requirementContract.parse({
		version: 1,
		taskId: task.id,
		rootRunId: task.root_run_id,
		cancelEpoch: task.cancel_epoch,
		originalRequest,
		question,
		requestDigest,
		profiles,
		requirements,
	});
	if (bytes(contract) > 16384) throw new Error("requirement_capacity_exceeded");
	const digest = hashRequirementData(contract);
	db.query("INSERT INTO agent_requirement_contracts VALUES(?,?,?,?,?)").run(
		task.id,
		1,
		canonicalRequirementJson(contract),
		digest,
		now,
	);
	return { contract, digest };
}
export function readRequirements(
	db: Database,
	task: Task,
	capabilities: Capabilities,
) {
	const row = db
		.query(
			"SELECT contract_json,contract_digest FROM agent_requirement_contracts WHERE task_id=?",
		)
		.get(task.id) as { contract_json: string; contract_digest: string } | null;
	if (!row) return null;
	const contract = requirementContract.parse(JSON.parse(row.contract_json));
	if (
		hashRequirementData(contract) !== row.contract_digest ||
		contract.taskId !== task.id ||
		contract.rootRunId !== task.root_run_id ||
		contract.cancelEpoch !== task.cancel_epoch
	)
		throw new Error("requirement_profile_invalidated");
	capabilities.validateRequirementProfilesInTransaction(db, contract.profiles);
	for (const r of contract.requirements)
		validateRequirementSchema(r.valueSchema);
	return { contract, digest: row.contract_digest };
}
export function validateDraft(
	raw: unknown,
	contract: RequirementContract,
): DraftReport {
	const parsed = draftReport.safeParse(raw);
	if (!parsed.success) throw new Error("invalid_requirement_report");
	const draft = parsed.data;
	if (bytes(draft) > 32768) throw new Error("requirement_capacity_exceeded");
	const ids = draft.checks.map((c) => c.requirementId);
	if (
		new Set(ids).size !== ids.length ||
		ids.length !== contract.requirements.length ||
		contract.requirements.some((r) => !ids.includes(r.id))
	)
		throw new Error("invalid_requirement_report");
	let total = 0;
	for (const c of draft.checks) {
		const r = contract.requirements.find((r) => r.id === c.requirementId)!;
		total += bytes(c.value);
		if (
			c.status === "satisfied" &&
			(!c.evidence.length || !requirementValueMatches(r.valueSchema, c.value))
		)
			throw new Error("invalid_requirement_report");
		if (
			c.status === "unsatisfied" &&
			(!c.evidence.length ||
				(c.value !== null && !requirementValueMatches(r.valueSchema, c.value)))
		)
			throw new Error("invalid_requirement_report");
		if (c.status === "unknown" && c.value !== null)
			throw new Error("invalid_requirement_report");
		if (
			c.status === "not_applicable" &&
			(!r.allowNotApplicable || c.value !== null || !c.evidence.length)
		)
			throw new Error("invalid_requirement_report");
		if (
			r.required &&
			["unknown", "unsatisfied"].includes(c.status) &&
			draft.outcome === "answered"
		)
			throw new Error("invalid_requirement_report");
		if (
			!r.required &&
			["unknown", "unsatisfied"].includes(c.status) &&
			!draft.limitations.length
		)
			throw new Error("invalid_requirement_report");
	}
	if (total > 8192) throw new Error("requirement_capacity_exceeded");
	if (
		draft.externalRules.some(
			(r, i) => r.id !== `x${i + 1}` || !ids.includes(r.requirementId),
		)
	)
		throw new Error("invalid_requirement_report");
	return draft;
}
export const draftReferences = (d: DraftReport) =>
	[
		...new Set(
			[...d.claims, ...d.checks, ...d.externalRules].flatMap((c) => c.evidence),
		),
	].sort();
export function saveDraft(
	db: Database,
	task: Task,
	contractDigest: string,
	draft: DraftReport,
	now: number,
) {
	db.query(
		"INSERT INTO agent_requirement_drafts(task_id,contract_digest,draft_json,draft_digest,state,created_at) VALUES(?,?,?,?,'pending',?)",
	).run(
		task.id,
		contractDigest,
		canonicalRequirementJson(draft),
		hashRequirementData(draft),
		now,
	);
}
export function readDraft(
	db: Database,
	taskId: string,
	contractDigest: string,
	state = "pending",
) {
	const row = db
		.query("SELECT * FROM agent_requirement_drafts WHERE task_id=?")
		.get(taskId) as {
		contract_digest: string;
		draft_json: string;
		draft_digest: string;
		state: string;
		verification_json: string | null;
		verification_digest: string | null;
	} | null;
	if (!row || row.state !== state || row.contract_digest !== contractDigest)
		throw new Error("requirement_verification_unavailable");
	const draft = draftReport.parse(JSON.parse(row.draft_json));
	if (hashRequirementData(draft) !== row.draft_digest)
		throw new Error("requirement_verification_failed");
	return { ...row, draft };
}
