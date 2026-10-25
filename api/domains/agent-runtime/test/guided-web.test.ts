import { expect, test } from "bun:test";
import { harness } from "./route-harness";

const urls = [1, 2, 3, 4].map((n) => `https://site${n}.example/page`);
async function searched(h: Awaited<ReturnType<typeof harness>>, run: string) {
	await h.start(run);
	const id = h.agents.list(run).find((t) => t.kind === "worker")!.id;
	const step = await h.runRawModelStep(id, {
		action: "invoke",
		tool: "web.lookup",
		arguments: { query: "依頼から選んだ検索語" },
	});
	expect(step.prep.status).toBe("ready");
	h.results.set("op1", {
		state: "succeeded",
		result: {
			observedAt: new Date().toISOString(),
			hits: urls.map((url) => ({
				url,
				title: "候補",
				snippet: "本文で確認する",
			})),
			documents: [],
			failures: [],
		},
	});
	await h.agents.reconcile();
	return id;
}
const finish = (reference: string) => ({
	action: "finish",
	report: {
		completion: "complete",
		answer: "確認した値は123.45です。",
		summary: "確認した値は123.45です。",
		claims: [
			{
				text: "確認した値は123.45です。",
				status: "verified",
				evidence: [reference],
			},
		],
		limitations: [],
	},
});

test("staggered batch arrivals use shared receipts and reserve the final answer without wait calls", async () => {
	const h = await harness(Date.now, undefined, true);
	try {
		const id = await searched(h, "batch");
		await h.runRawModelStep(id, {
			action: "invoke",
			tool: "web.read",
			arguments: { url: urls[0] },
			readAhead: urls.slice(1),
		});
		expect(h.started).toHaveLength(5);
		expect(h.task(id).acquisition_plan_json).toBeNull();
		for (let n = 2; n <= 4; n++) {
			h.results.set(
				`op${n}`,
				h.doc("必要な値はまだ確認できません。", urls[n - 2]),
			);
			await h.agents.reconcile();
			expect(h.task(id).state).toBe("waiting_tool");
			expect(h.task(id).model_calls).toBe(2);
			const early = await h.runRawModelStep(id, { action: "wait" });
			expect(early.prep.status).toBe("stale");
		}
		h.results.set("op5", h.doc("確認した値は123.45です。", urls[3]));
		await h.agents.reconcile();
		expect(h.task(id).state).toBe("queued");
		const result = await h.runRawModelStep(
			id,
			(input: { messages: Array<{ content: string }> }) => {
				const material = JSON.parse(
					input.messages[1]!.content.split("=").slice(1).join("="),
				);
				const excerpt = material.observations
					.flatMap(
						(o: { excerpts: Array<{ reference: string; quote: string }> }) =>
							o.excerpts,
					)
					.find((e: { quote: string }) => e.quote.includes("123.45"));
				return finish(excerpt.reference);
			},
		);
		expect(result.prep.status).toBe("ready");
		expect(h.task(id).state).toBe("completed");
		expect(h.task(id).model_calls).toBe(3);
		expect(h.agents.report(id)?.claims[0]?.evidence[0]?.quote).toContain(
			"123.45",
		);
		const ticket = h.store.read((db) =>
			h.agents.prepareAnswerInTransaction(db, "batch"),
		);
		expect(JSON.parse(ticket.projection!).answer).toContain("123.45");
	} finally {
		await h.close();
	}
});

test("failed reads remain observations and a batch resumes once after its final receipt", async () => {
	const h = await harness(Date.now, undefined, true);
	try {
		const id = await searched(h, "failures");
		await h.runRawModelStep(id, {
			action: "invoke",
			tool: "web.read",
			arguments: { url: urls[0] },
			readAhead: [urls[1]],
		});
		h.results.set("op2", { state: "failed", errorCode: "web_timeout" });
		await h.agents.reconcile();
		expect(h.task(id).state).toBe("waiting_tool");
		h.results.set("op3", h.doc("確認した値は123.45です。", urls[1]));
		await h.agents.reconcile();
		await h.runRawModelStep(id, finish("e1"));
		expect(h.task(id).state).toBe("completed");
		expect(h.agents.report(id)?.coverage).toBe("partial");
	} finally {
		await h.close();
	}
});

test("batch cancellation rejects late successful results and cancels every pending call", async () => {
	const h = await harness(Date.now, undefined, true);
	try {
		const id = await searched(h, "cancel-batch");
		await h.runRawModelStep(id, {
			action: "invoke",
			tool: "web.read",
			arguments: { url: urls[0] },
			readAhead: urls.slice(1),
		});
		await h.store.write((db) =>
			h.agents.cancelTreeInTransaction(db, "cancel-batch"),
		);
		for (let n = 2; n <= 5; n++)
			h.results.set(`op${n}`, h.doc("遅れて到着した値123.45", urls[n - 2]));
		await h.agents.reconcile();
		expect(h.tools.pending()).toHaveLength(0);
		expect(h.task(id).state).toBe("cancelled");
		expect(() => h.agents.report(id)).toThrow("report_not_ready");
	} finally {
		await h.close();
	}
});

test("unpresented evidence still requires repair and cannot become an accepted report", async () => {
	const h = await harness(Date.now, undefined, true);
	try {
		const id = await searched(h, "unknown-ref");
		await h.runRawModelStep(id, {
			action: "invoke",
			tool: "web.read",
			arguments: { url: urls[0] },
		});
		h.results.set("op2", h.doc("確認した値は123.45です。", urls[0]));
		await h.agents.reconcile();
		await h.runRawModelStep(id, finish("e99"));
		expect(h.task(id).error_code).toBe("invalid_evidence");
		expect(() => h.agents.report(id)).toThrow("report_not_ready");
		await h.runRawModelStep(id, finish("e1"));
		expect(h.task(id).state).toBe("completed");
	} finally {
		await h.close();
	}
});
