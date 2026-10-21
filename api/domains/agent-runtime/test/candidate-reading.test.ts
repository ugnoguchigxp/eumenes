import { expect, test } from "bun:test";
import { harness } from "./route-harness";

test("a candidate read resolves its observed URL and then supports body evidence", async () => {
	const h = await harness(Date.now, false, undefined, true, true);
	try {
		await h.store.write((db) =>
			h.agents.startInTransaction(db, {
				rootRunId: "candidate-read",
				input: {
					kind: "web",
					question: "対象サイトの教材の学習時間を確認",
					packageRevisionId: "package:web.service-search@3",
				},
				deadline: Date.now() + 360000,
			}),
		);
		const id = h.agents
			.list("candidate-read")
			.find((t) => t.kind === "worker")!.id;
		await h.runRawModelStep(id, {
			action: "invoke",
			tool: "web.lookup",
			arguments: { query: "教材 example.org" },
		});
		h.results.set("op1", {
			state: "succeeded",
			result: {
				observedAt: new Date().toISOString(),
				hits: [
					{
						url: "https://example.org/course",
						title: "教材",
						snippet: "本文で学習時間を確認",
					},
				],
				documents: [],
				failures: [],
			},
		});
		await h.agents.reconcile();
		await h.runRawModelStep(id, {
			action: "invoke",
			tool: "web.read",
			arguments: { candidateRef: "c1" },
		});
		expect(h.started[1]).toMatchObject({
			toolId: "web.read",
			args: { url: "https://example.org/course" },
		});
		h.results.set(
			"op2",
			h.doc("学習時間は30分です。", "https://example.org/course"),
		);
		await h.agents.reconcile();
		await h.runRawModelStep(
			id,
			(input: { messages: { content: string }[] }) => {
				const raw = input.messages.find((m) =>
					m.content.startsWith("UNTRUSTED_MATERIALS"),
				)!.content;
				const materials = JSON.parse(raw.slice(raw.indexOf("=") + 1));
				const ref = materials.observations
					.flatMap(
						(o: { excerpts: { reference: string; quote: string }[] }) =>
							o.excerpts,
					)
					.find((e: { quote: string }) => e.quote.includes("30分")).reference;
				return {
					action: "finish",
					report: {
						completion: "complete",
						answer: "学習時間は30分です。",
						summary: "学習時間は30分",
						resultKind: "facts",
						candidateRefs: [],
						claims: [
							{ text: "学習時間は30分", status: "verified", evidence: [ref] },
						],
						limitations: [],
					},
				};
			},
		);
		expect(h.task(id).state).toBe("completed");
		const row = h.store.read((db) =>
			db.query("SELECT report_json FROM agent_reports WHERE task_id=?").get(id),
		) as { report_json: string };
		expect(JSON.parse(row.report_json)).toMatchObject({
			outcome: "answered",
			claims: [{ text: "学習時間は30分" }],
		});
	} finally {
		await h.close();
	}
});
