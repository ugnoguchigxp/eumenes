import { expect, test } from "bun:test";
import { harness } from "./route-harness";
import { fixtureVerification } from "./research-fixture";
const requirements = [
	{
		id: "r1",
		statement: "依頼の条件を調べる",
		requestQuote: "調査",
		valueSchema: { type: "string", maxLength: 2000 },
	},
];
const draft = {
	outcome: "not_found",
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
test("unsupported extracted schema uses the shared single repair and cannot freeze or execute", async () => {
	const h = await harness();
	try {
		await h.start("schema-repair", "調査");
		const c = h.agents.list("schema-repair").find((t) => t.kind === "worker")!;
		await h.runRawModelStep(c.id, {
			action: "finish",
			requirements: [{ ...requirements[0], valueSchema: { type: "string" } }],
			report: draft,
		});
		expect(h.task(c.id).json_repairs).toBe(1);
		expect(h.task(c.id).state).toBe("queued");
		expect(h.started).toHaveLength(0);
		expect(
			h.store.read((db) =>
				db.query("SELECT COUNT(*) AS n FROM agent_requirement_contracts").get(),
			),
		).toEqual({ n: 0 });
		await h.runRawModelStep(c.id, {
			action: "finish",
			requirements,
			report: draft,
		});
		expect(h.task(c.id).phase).toBe("verify_requirements");
		await h.runRawModelStep(c.id, { invalid: "verification" });
		expect(h.task(c.id).state).toBe("failed");
		expect(h.task(c.id).json_repairs).toBe(1);
	} finally {
		await h.close();
	}
});
for (const field of [
	"requestCovered",
	"summarySupported",
	"limitationsConsistent",
] as const)
	test(`semantic rejection ${field} never adopts a pending draft or retries`, async () => {
		const h = await harness();
		try {
			await h.start(field, "調査");
			const c = h.agents.list(field).find((t) => t.kind === "worker")!;
			await h.runRawModelStep(c.id, {
				action: "finish",
				requirements,
				report: draft,
			});
			expect(h.task(c.id).phase).toBe("verify_requirements");
			expect(
				h.store.read((db) =>
					db
						.query("SELECT COUNT(*) AS n FROM agent_reports WHERE task_id=?")
						.get(c.id),
				),
			).toEqual({ n: 0 });
			const verification = {
				...fixtureVerification(draft as never),
				[field]: false,
			};
			const result = await h.runRawModelStep(c.id, verification);
			expect(result.prep.status).toBe("ready");
			if (result.prep.status === "ready") {
				expect(result.prep.input.mode).toBe("verify_requirements");
				expect(result.prep.input.messages[0]!.content).toContain("TOOLS=[]");
			}
			expect(h.task(c.id).state).toBe("failed");
			expect(h.task(c.id).json_repairs).toBe(0);
			expect(
				h.store.read((db) =>
					db
						.query("SELECT COUNT(*) AS n FROM agent_reports WHERE task_id=?")
						.get(c.id),
				),
			).toEqual({ n: 0 });
			expect(h.started).toHaveLength(0);
		} finally {
			await h.close();
		}
	});
test("a structurally invalid first action rolls back frozen requirements with zero tool execution", async () => {
	const h = await harness();
	try {
		await h.start("rollback", "調査");
		const c = h.agents.list("rollback").find((t) => t.kind === "worker")!;
		await h.runRawModelStep(c.id, {
			action: "invoke",
			requirements,
			tool: "web.lookup",
			arguments: { unexpected: true },
		});
		expect(
			h.store.read((db) =>
				db.query("SELECT COUNT(*) AS n FROM agent_requirement_contracts").get(),
			),
		).toEqual({ n: 0 });
		expect(h.started).toHaveLength(0);
		expect(h.task(c.id).json_repairs).toBe(1);
		await h.runRawModelStep(c.id, {
			action: "finish",
			requirements,
			report: draft,
		});
		await h.runRawModelStep(c.id, { invalid: "verification" });
		expect(h.task(c.id).state).toBe("failed");
		expect(h.task(c.id).json_repairs).toBe(1);
		expect(
			h.store.read((db) =>
				db
					.query("SELECT COUNT(*) AS n FROM agent_reports WHERE task_id=?")
					.get(c.id),
			),
		).toEqual({ n: 0 });
	} finally {
		await h.close();
	}
});
test("a pending draft is accepted only after one complete verification", async () => {
	const h = await harness();
	try {
		await h.start("accept", "調査");
		const c = h.agents.list("accept").find((t) => t.kind === "worker")!;
		await h.runRawModelStep(c.id, {
			action: "finish",
			requirements,
			report: draft,
		});
		expect(
			h.store.read((db) =>
				db
					.query("SELECT COUNT(*) AS n FROM agent_reports WHERE task_id=?")
					.get(c.id),
			),
		).toEqual({ n: 0 });
		await h.runRawModelStep(c.id, fixtureVerification(draft as never));
		expect(h.agents.report(c.id)?.version).toBe(3);
		expect(h.task(c.id).model_calls).toBe(2);
	} finally {
		await h.close();
	}
});

test("R13 a valid deadline value backed by an opening-time excerpt is rejected by semantic verification", async () => {
	const h = await harness();
	try {
		await h.start(
			"wrong-deadline",
			"調査 https://example.org/fixtures/opening-time",
		);
		const c = h.agents.list("wrong-deadline").find((t) => t.kind === "worker")!;
		await h.runRawModelStep(c.id, {
			action: "invoke",
			requirements,
			tool: "web.read",
			arguments: { url: "https://example.org/fixtures/opening-time" },
		});
		h.results.set(
			"op1",
			h.doc(
				"受付開始は2026年10月12日09:00 JST。申込締切ではありません。",
				"https://example.org/fixtures/opening-time",
			),
		);
		await h.agents.reconcile();
		const candidate = {
			outcome: "answered" as const,
			summary: "締切は2026年10月12日09:00 JST",
			claims: [{ text: "締切は2026年10月12日09:00 JST", evidence: ["e1"] }],
			limitations: [],
			checks: [
				{
					requirementId: "r1",
					status: "satisfied" as const,
					value: "2026-10-12T00:00:00Z",
					evidence: ["e1"],
					reason: "日時の型は正しい",
				},
			],
			externalRules: [],
		};
		await h.runRawModelStep(c.id, { action: "finish", report: candidate });
		expect(h.task(c.id).phase).toBe("verify_requirements");
		const verification = fixtureVerification(candidate);
		verification.checks[0]!.supported = false;
		await h.runRawModelStep(c.id, verification);
		expect(h.task(c.id).state).toBe("failed");
		expect(h.task(c.id).json_repairs).toBe(0);
		expect(
			h.store.read((db) =>
				db
					.query("SELECT COUNT(*) AS n FROM agent_reports WHERE task_id=?")
					.get(c.id),
			),
		).toEqual({ n: 0 });
		expect(h.started).toHaveLength(1);
	} finally {
		await h.close();
	}
});
