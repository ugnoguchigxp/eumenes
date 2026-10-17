import { expect, test } from "bun:test";
import { ValidationFailure } from "../../../infrastructure/validation-log";
import type { Prepared } from "../../capabilities";
import type { Task } from "../contracts";
import { workerContext } from "../service/context";
import { EvidenceCatalog } from "../service/evidence-catalog";
import { explorationBudget, modelLimit } from "../service/exploration";
import { freezeRequirements, validateDraft } from "../service/requirements";
import { fixtureVerification } from "./research-fixture";
import { requirementHarness, requests } from "./requirement-harness";
import { harness } from "./route-harness";

const failureOf = (run: () => unknown) => {
	try {
		run();
	} catch (e) {
		return e;
	}
	throw new Error("accepted");
};
const issuesOf = (run: () => unknown) => {
	const e = failureOf(run);
	expect(e).toBeInstanceOf(ValidationFailure);
	return {
		code: (e as Error).message,
		issues: (e as ValidationFailure).issues,
	};
};
const requirements = [
	{
		id: "r1",
		statement: "依頼の条件を調べる",
		requestQuote: "調査",
		valueSchema: { type: "string", maxLength: 2000 },
	},
];
const draft = {
	outcome: "clarification_required",
	summary: "資料がありません",
	claims: [],
	limitations: ["条件は確認できない"],
	checks: [
		{
			requirementId: "r1",
			status: "unknown",
			value: null,
			evidence: [],
			reason: "根拠なし",
		},
	],
	externalRules: [],
};
const saved = (h: Awaited<ReturnType<typeof harness>>, id: string) =>
	JSON.parse(h.task(id).control_repair_json ?? "[]") as Array<
		Record<string, unknown>
	>;

test("a draft that breaks the contract names the failing check and condition", async () => {
	const { h, child } = await requirementHarness();
	try {
		const frozen = await h.store.write((db) =>
			freezeRequirements(db, h.task(child.id), requests, h.caps, Date.now()),
		);
		const good = {
			outcome: "partial",
			summary: "一部確認できない",
			claims: [{ text: "数量は2", evidence: ["e1"] }],
			limitations: ["明示条件不明"],
			checks: [
				{
					requirementId: "r1",
					status: "unknown",
					value: null,
					evidence: [],
					reason: "未確認",
				},
				{
					requirementId: "p1.quantity",
					status: "satisfied",
					value: 2,
					evidence: ["e1"],
					reason: "資料で確認",
				},
			],
			externalRules: [],
		};
		const contract = frozen.contract;
		expect(
			issuesOf(() => validateDraft({ ...good, outcome: "answered" }, contract)),
		).toEqual({
			code: "invalid_requirement_report",
			issues: [
				{
					validationPath: "report.checks.0.status",
					validationCode: "required_unmet_but_answered",
				},
			],
		});
		expect(
			issuesOf(() =>
				validateDraft(
					{
						...good,
						checks: [good.checks[0], { ...good.checks[1], value: "2" }],
					},
					contract,
				),
			).issues,
		).toEqual([
			{
				validationPath: "report.checks.1.value",
				validationCode: "value_schema_mismatch",
			},
		]);
		expect(
			issuesOf(() =>
				validateDraft({ ...good, checks: [good.checks[0]] }, contract),
			).issues,
		).toEqual([
			{
				validationPath: "report.checks",
				validationCode: "requirements_mismatch",
			},
		]);
		expect(issuesOf(() => validateDraft({ summary: 1 }, contract)).code).toBe(
			"invalid_requirement_report",
		);
		expect(
			issuesOf(() => validateDraft({ summary: 1 }, contract)).issues.length,
		).toBeGreaterThan(0);
		expect(
			issuesOf(() =>
				validateDraft(
					{
						...good,
						externalRules: [
							{
								id: "x2",
								requirementId: "r1",
								statement: "条件",
								scope: "範囲",
								validFrom: null,
								validUntil: null,
								evidence: ["e1"],
							},
						],
					},
					contract,
				),
			).issues,
		).toEqual([
			{
				validationPath: "report.externalRules.0.id",
				validationCode: "unexpected_id",
			},
		]);
	} finally {
		await h.close();
	}
});

test("a request item that breaks the contract is located by position", async () => {
	const { h, child } = await requirementHarness();
	try {
		const freeze = (items: unknown) => () =>
			h.store.write((db) =>
				freezeRequirements(
					db,
					h.task(child.id),
					items as never,
					h.caps,
					Date.now(),
				),
			);
		const run = async (items: unknown) => {
			try {
				await freeze(items)();
			} catch (e) {
				return e as ValidationFailure;
			}
			throw new Error("accepted");
		};
		const quote = await run([{ ...requests[0], requestQuote: "存在しない文" }]);
		expect(quote).toBeInstanceOf(ValidationFailure);
		expect(quote.message).toBe("invalid_requirement_contract");
		expect(quote.issues).toEqual([
			{
				validationPath: "requirements.0.requestQuote",
				validationCode: "quote_not_in_request",
			},
		]);
		expect((await run([{ ...requests[0], id: "r2" }])).issues).toEqual([
			{ validationPath: "requirements.0.id", validationCode: "unexpected_id" },
		]);
		const schema = await run([
			{ ...requests[0], valueSchema: { type: "string", pattern: "x" } },
		]);
		expect(schema.message).toBe("invalid_requirement_schema");
		expect(schema.issues).toEqual([
			{
				validationPath: "requirements.0.valueSchema",
				validationCode: "unsupported_keyword",
			},
		]);
	} finally {
		await h.close();
	}
});

test("an unsupported value schema stores its reason as the repair issue", async () => {
	const h = await harness();
	try {
		await h.startHistory("schema-issue", "調査");
		const c = h.agents.list("schema-issue").find((t) => t.kind === "worker")!;
		await h.runRawModelStep(c.id, {
			action: "finish",
			requirements: [
				{
					...requirements[0],
					valueSchema: { type: "string", pattern: "unsupported" },
				},
			],
			report: draft,
		});
		expect(h.task(c.id).error_code).toBe("invalid_requirement_schema");
		expect(saved(h, c.id)).toEqual([
			{
				validationPath: "requirements.0.valueSchema",
				validationCode: "unsupported_keyword",
			},
		]);
	} finally {
		await h.close();
	}
});

test("a bad document reference stores the field and reason as the repair issue", async () => {
	const catalog = new EvidenceCatalog();
	const { issues, code } = issuesOf(() =>
		catalog.arguments({ sourceRef: "d99" }),
	);
	expect(code).toBe("invalid_tool_input");
	expect(issues).toEqual([
		{
			validationPath: "arguments.sourceRef",
			validationCode: "unknown_document_ref",
		},
	]);
});

test("semantic verification failure records which items failed and keeps the task failed", async () => {
	const h = await harness();
	try {
		await h.startHistory("verify-issues", "調査");
		const c = h.agents.list("verify-issues").find((t) => t.kind === "worker")!;
		await h.runRawModelStep(c.id, {
			action: "finish",
			requirements,
			report: draft,
		});
		const verification = fixtureVerification(draft as never);
		await h.runRawModelStep(c.id, {
			...verification,
			requestCovered: false,
			checks: verification.checks.map((x: object) => ({
				...x,
				supported: false,
			})),
		});
		expect(h.task(c.id).state).toBe("failed");
		expect(h.task(c.id).error_code).toBe("requirement_verification_failed");
		expect(saved(h, c.id)).toEqual([
			{ validationPath: "requestCovered", validationCode: "not_covered" },
			{ validationPath: "checks.0.supported", validationCode: "not_supported" },
		]);
	} finally {
		await h.close();
	}
});

test("a verification output with the wrong items is repaired with the failing positions as data", async () => {
	const h = await harness();
	try {
		await h.startHistory("verify-repair", "調査");
		const c = h.agents.list("verify-repair").find((t) => t.kind === "worker")!;
		await h.runRawModelStep(c.id, {
			action: "finish",
			requirements,
			report: draft,
		});
		const verification = fixtureVerification(draft as never);
		await h.runRawModelStep(c.id, {
			...verification,
			checks: [{ ...verification.checks[0], requirementId: "r9" }],
		});
		expect(h.task(c.id).state).toBe("queued");
		expect(h.task(c.id).error_code).toBe("invalid_requirement_verification");
		const second = await h.runRawModelStep(c.id, { invalid: "verification" });
		if (second.prep.status !== "ready") throw new Error("not ready");
		const messages = second.prep.input.messages;
		const data = JSON.parse(messages.find((m) => m.role === "user")!.content);
		expect(data.lastResult).toEqual({
			code: "invalid_requirement_verification",
			issues: [
				{ validationPath: "checks", validationCode: "requirement_mismatch" },
			],
		});
	} finally {
		await h.close();
	}
});

const prepared = {
	package: {
		backend: "web",
		profileRevisionId: "profile:p@1",
		requiredSkillRevisionIds: ["skill:s@1"],
	},
	dependencies: [
		{ revisionId: "profile:p@1", hash: "p", body: "profile" },
		{ revisionId: "skill:s@1", hash: "s", body: "planner" },
	],
	input: { question: "依頼" },
} as Prepared;
const base = { deadline: 180000, model_calls: 1, input_json: "{}" } as Task;
const noticeCount = (messages: Array<{ role: string; content: string }>) =>
	messages.filter(
		(m) => m.role === "system" && m.content.includes("拒否コード="),
	).length;

test("the repair notice follows the actual rejection code", () => {
	const tool = [
		{
			executionRef: "read",
			tool: { id: "web.read", schemaKey: "read" as const },
		},
	];
	const contextFor = (error_code: string | null) =>
		workerContext(
			{ ...base, json_repairs: 1, error_code } as Task,
			prepared,
			tool,
			[],
			[],
			new EvidenceCatalog(),
			0,
		);
	for (const code of [
		"invalid_control_json",
		"invalid_tool_input",
		"invalid_requirement_report",
		"tool_url_out_of_scope",
	]) {
		const messages = contextFor(code).messages;
		expect(noticeCount(messages)).toBe(1);
		expect(messages.at(-2)!.content).toContain(`拒否コード=${code}`);
	}
	for (const code of ["research_no_progress", "source_unusable", null])
		expect(noticeCount(contextFor(code).messages)).toBe(0);
});

test("tools that are withheld come with the reason as a state value", () => {
	const tool = [
		{
			executionRef: "read",
			tool: { id: "web.read", schemaKey: "read" as const },
		},
	];
	const stalled = workerContext(
		{ ...base, error_code: "research_no_progress" } as Task,
		prepared,
		[],
		[],
		[],
		new EvidenceCatalog(),
		0,
	);
	const stalledData = JSON.parse(stalled.messages.at(-1)!.content);
	expect(stalledData.lastResult.code).toBe("research_no_progress");
	const source = (i: number) => ({
		sourceId: `s${i}`,
		sourceRef: "stored-body",
		viewId: crypto.randomUUID(),
		body: `根拠${i}`,
		title: "資料",
		basis: "page" as const,
		url: "https://example.com/",
		fetchedAt: "2026-10-10T00:00:00Z",
		truncated: false,
	});
	const full = workerContext(
		base,
		prepared,
		tool,
		Array.from({ length: 65 }, (_, i) => source(i)),
		[],
		new EvidenceCatalog(),
		0,
	);
	expect(JSON.parse(full.messages.at(-1)!.content)).toMatchObject({
		evidenceCapacityReached: true,
	});
	const open = workerContext(
		base,
		prepared,
		tool,
		[],
		[],
		new EvidenceCatalog(),
		0,
	);
	expect(
		JSON.parse(open.messages.at(-1)!.content).evidenceCapacityReached,
	).toBe(false);
});

test("the prompt time is local ISO 8601 with its offset", () => {
	const context = workerContext(
		base,
		prepared,
		[],
		[],
		[],
		new EvidenceCatalog(),
		Date.UTC(2026, 9, 17, 16, 30),
	);
	expect(JSON.parse(context.messages.at(-1)!.content)).toMatchObject({
		now: "2026-10-18T01:30:00.000+09:00",
		timeZone: "Asia/Tokyo",
	});
});

test("operations stop early enough to leave finish, verification and one repair", () => {
	const limit = modelLimit(prepared);
	const task = (model_calls: number) =>
		({ ...base, model_calls, deadline: 180000 }) as Task;
	expect(explorationBudget(task(limit - 3), prepared, [], 0).canOperate).toBe(
		true,
	);
	expect(explorationBudget(task(limit - 2), prepared, [], 0).canOperate).toBe(
		false,
	);
	expect(
		explorationBudget(task(limit - 3), prepared, [], 0).maxModelCalls,
	).toBe(limit);
});

test("a finish that leaves no room for verification is not saved", async () => {
	for (const [calls, accepted] of [
		[5, true],
		[6, false],
	] as const) {
		const h = await harness();
		try {
			const id = `budget-${calls}`;
			await h.startHistory(id, "調査");
			const c = h.agents.list(id).find((t) => t.kind === "worker")!;
			expect(modelLimit({ package: { backend: "history" } } as Prepared)).toBe(
				7,
			);
			await h.store.write((db) =>
				db
					.query("UPDATE agent_tasks SET model_calls=? WHERE id=?")
					.run(calls, c.id),
			);
			await h.runRawModelStep(c.id, {
				action: "finish",
				requirements,
				report: draft,
			});
			if (accepted) expect(h.task(c.id).phase).toBe("verify_requirements");
			else {
				expect(h.task(c.id).state).toBe("failed");
				expect(h.task(c.id).error_code).toBe(
					"requirement_verification_unavailable",
				);
			}
		} finally {
			await h.close();
		}
	}
});
