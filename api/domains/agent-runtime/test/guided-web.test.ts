import { expect, test } from "bun:test";
import { harness } from "./route-harness";
import { webReadState } from "../service/web-read-state";

const urls = [
	"https://a.example/one",
	"https://b.example/two",
	"https://c.example/three",
	"https://d.example/four",
];
async function searched(h: Awaited<ReturnType<typeof harness>>, id: string) {
	await h.start(id);
	const child = h.agents.list(id).find((t) => t.kind === "worker")!;
	expect(child.packageRevisionId).toBe("package:web.quick@4");
	const first = await h.runRawModelStep(child.id, {
		action: "invoke",
		tool: "web.lookup",
		arguments: { query: "依頼から選んだ検索語" },
	});
	if (first.prep.status === "ready") {
		expect(first.prep.input.control).toBeDefined();
		expect(
			JSON.stringify(first.prep.input.control?.outputSchema),
		).not.toContain('"mission"');
	}
	expect(h.started).toHaveLength(1);
	expect(webReadState(h.task(child.id))).not.toHaveProperty("mission");
	h.results.set("op1", {
		state: "succeeded",
		result: {
			observedAt: new Date().toISOString(),
			hits: urls.map((url) => ({
				url,
				title: "候補",
				snippet: "候補の数値は根拠にできない",
			})),
			documents: [],
			failures: [],
		},
	});
	await h.agents.reconcile();
	return child.id;
}
const finish = (reference: string) => ({
	action: "finish",
	report: {
		completion: "complete",
		answer: "本文で確認した値です。",
		summary: "本文で確認した値です。",
		claims: [
			{
				text: "本文で確認した値です。",
				status: "verified",
				evidence: [reference],
			},
		],
		limitations: [],
	},
});

test("paired reads hedge after ten seconds, buffer arrivals during evaluation, and cancel remaining work on finish", async () => {
	let clock = Date.now();
	const h = await harness(() => clock, false, undefined, true);
	try {
		const id = await searched(h, "paired");
		const selected = await h.runRawModelStep(id, {
			action: "invoke",
			tool: "web.read",
			arguments: { url: urls[0] },
			readAhead: urls.slice(1).map((url) => ({ url })),
		});
		expect(selected.prep.status).toBe("ready");
		if (selected.prep.status === "ready") {
			const material = JSON.parse(
				selected.prep.input.messages[1]!.content.split("=").slice(1).join("="),
			);
			expect(material.candidates).toHaveLength(4);
			expect(material.evidence).toEqual([]);
			expect(
				Buffer.byteLength(JSON.stringify(selected.prep.input.messages)),
			).toBeLessThanOrEqual(65536);
		}
		expect(h.started).toHaveLength(3); // search + first pair
		clock += 9999;
		await h.agents.reconcile();
		expect(h.started).toHaveLength(3);
		clock++;
		await h.agents.reconcile();
		expect(h.started).toHaveLength(5);
		expect(h.tools.pending()).toHaveLength(4); // first pair was not cancelled
		h.results.set("op2", h.doc("先に届いた本文。", urls[0]));
		await h.agents.reconcile();
		expect(h.task(id).state).toBe("queued");
		await h.runRawModelStep(id, { action: "wait" }, async () => {
			h.results.set("op3", h.doc("評価中に届いた本文。", urls[1]));
			await h.agents.reconcile();
			expect(h.task(id).state).toBe("running");
		});
		expect(h.task(id).state).toBe("queued");
		expect(webReadState(h.task(id)).arrivals).toBe(2);
		await h.runRawModelStep(id, finish("e1"));
		expect(h.task(id).state).toBe("completed");
		expect(h.tools.pending()).toHaveLength(0);
		const root = h.agents.list("paired").find((t) => t.kind === "coordinator")!;
		const ticket = h.store.read((db) =>
			h.agents.prepareAnswerInTransaction(db, "paired"),
		);
		expect(ticket.taskId).toBe(root.id);
		expect(JSON.parse(ticket.projection!)).toMatchObject({
			delivery: "guided-web",
			completion: "complete",
		});
	} finally {
		await h.close();
	}
});

test("empty active count does not schedule another pair after a successful body", async () => {
	const h = await harness(Date.now, false, undefined, true);
	try {
		const id = await searched(h, "success-group");
		await h.runRawModelStep(id, {
			action: "invoke",
			tool: "web.read",
			arguments: { url: urls[0] },
			readAhead: urls.slice(1).map((url) => ({ url })),
		});
		h.results.set("op2", h.doc("必要な本文。", urls[0]));
		h.results.set("op3", h.doc("もう一つの本文。", urls[1]));
		await h.agents.reconcile();
		expect(h.started).toHaveLength(3);
		await h.runRawModelStep(id, finish("e1"));
		expect(h.task(id).state).toBe("completed");
	} finally {
		await h.close();
	}
});

test("failed pair starts the next pair immediately and legitimate unknown may complete the response", async () => {
	const h = await harness(Date.now, false, undefined, true);
	try {
		const id = await searched(h, "failed-group");
		await h.runRawModelStep(id, {
			action: "invoke",
			tool: "web.read",
			arguments: { url: urls[0] },
			readAhead: urls.slice(1).map((url) => ({ url })),
		});
		for (const n of [2, 3])
			h.results.set(`op${n}`, { state: "failed", errorCode: "web_timeout" });
		await h.agents.reconcile();
		expect(h.started).toHaveLength(5);
		for (const n of [4, 5])
			h.results.set(`op${n}`, { state: "failed", errorCode: "web_timeout" });
		await h.agents.reconcile();
		await h.runRawModelStep(id, {
			action: "finish",
			report: {
				completion: "complete",
				answer: "該当する事実は確認できませんでした。",
				summary: "確認できません。",
				claims: [{ text: "現在値は不明。", status: "unknown", evidence: [] }],
				limitations: ["取得できた範囲に回答の根拠がありません。"],
			},
		});
		expect(h.task(id).state).toBe("completed");
		expect(h.agents.report(id)?.claims).toEqual([]);
	} finally {
		await h.close();
	}
});

test("an evaluation cannot cite a body that arrived after its corpus was frozen", async () => {
	const h = await harness(Date.now, false, undefined, true);
	try {
		const id = await searched(h, "late-reference");
		await h.runRawModelStep(id, {
			action: "invoke",
			tool: "web.read",
			arguments: { url: urls[0] },
			readAhead: [{ url: urls[1] }],
		});
		h.results.set("op2", h.doc("既に提示した本文。", urls[0]));
		await h.agents.reconcile();
		await h.runRawModelStep(id, finish("e2"), async () => {
			h.results.set("op3", h.doc("まだ提示していない本文。", urls[1]));
			await h.agents.reconcile();
		});
		expect(h.task(id).state).toBe("queued");
		expect(h.task(id).error_code).toBe("invalid_evidence");
		expect(() => h.agents.report(id)).toThrow("report_not_ready");
		await h.runRawModelStep(id, finish("e2"));
		expect(h.task(id).state).toBe("completed");
	} finally {
		await h.close();
	}
});
