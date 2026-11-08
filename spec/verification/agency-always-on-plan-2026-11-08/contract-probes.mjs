/** Read-only contract probes: scripted responses, no server, DB, or provider calls. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(process.argv[2] ?? "../eumenes_agency");
const files = [
	"src/always-on/agent.ts",
	"src/always-on/contracts.ts",
	"src/always-on/forgetting.ts",
	"src/always-on/prompt.ts",
	"src/always-on/stock.ts",
];
const fingerprints = () => Object.fromEntries(files.map((file) => [
	file,
	createHash("sha256").update(readFileSync(resolve(root, file))).digest("hex"),
]));
const before = fingerprints();
const { createAlwaysOnAgent } = await import(pathToFileURL(resolve(root, files[0])).href);
const { ALWAYS_ON_VERSION, PREPARING_TTL_MS } = await import(pathToFileURL(resolve(root, files[1])).href);
const idle = () => ({ busy: false });
const signal = () => new AbortController().signal;
const user = (id, at, text) => ({ id, kind: "exchange.adopted", actor: "user", occurredAt: at, text });
const thought = (text, utterance = null) => ({
	thought: text,
	drive: "presence",
	userOps: [],
	stockOps: [],
	pace: { op: "none", minutes: null, evidenceRefs: [] },
	action: { kind: utterance === null ? "wait" : "speak", utterance, toolName: null, toolInput: null, evidenceRefs: [] },
	next: "normal",
});
const scripted = (reply) => {
	const requests = [];
	return {
		requests,
		async complete(request) {
			requests.push(request);
			return {
				value: request.schema.parse(reply(JSON.parse(request.prompt), requests.length)),
				model: "scripted",
				inputTokens: 1,
				outputTokens: 1,
				cacheReadTokens: 0,
				latencyMs: 0,
			};
		},
	};
};
const tools = [{ name: "probe_reader", description: "fixture reader", effect: "read", requiresApproval: false,
	input: { sources: ["capability:probe-revision"], complete: true } }];
const results = [];

// Forgetting happens after issue, before the receipt arrives.
{
	const agent = createAlwaysOnAgent({ llm: scripted(() => thought("検証用の考え", "検証用の一言")) });
	agent.observe(user("forgotten-user", 0, "検証用の好み"));
	const { ticket } = await agent.tick(10_000, idle, signal());
	assert.ok(ticket);
	agent.forget(["forgotten-user"]);
	const receipt = agent.recordResult({ ticketId: ticket.id, status: "succeeded", at: 11_000 });
	assert.ok(receipt);
	assert.ok(receipt.refs.includes("forgotten-user"));
	results.push({ id: "AO-N1", expectedAfterFix: "忘却した出典に依存する遅延receiptは観測・発話回数を増やさない",
		observed: { receiptAccepted: true, observations: agent.view().observations, unanswered: agent.view().pacing.unanswered }, contractGapReproduced: true });
}

// The second tick reads an earlier thought after its source left the observation window.
{
	const llm = scripted((data, n) => {
		if (n === 2) {
			assert.ok(data.thoughts.some((t) => t.text.includes("紫")));
			assert.ok(!data.observations.some((o) => o.id === "old-user"));
		}
		return thought(n === 1 ? "検証用の好きな色は紫" : "前の考えから紫の話題を準備する");
	});
	const agent = createAlwaysOnAgent({ llm });
	agent.observe(user("old-user", 0, "検証用の好きな色は紫"));
	await agent.tick(10_000, idle, signal());
	for (let i = 0; i < 21; i++) agent.observe(user(`new-${i}`, 20_000 + i, `独立した検証用発言${i}`));
	await agent.tick(30_000, idle, signal());
	assert.ok(!llm.requests[1].input.sources.includes("old-user"));
	agent.forget(["old-user"]);
	assert.ok(agent.view().thoughts.some((t) => t.text.includes("紫")));
	results.push({ id: "AO-N2", expectedAfterFix: "提示した過去の考えの依存元を次の出力へ継承し、忘却を連鎖させる",
		observed: { inheritedSourceMissing: true, dependentThoughtRetainedAfterForget: true }, contractGapReproduced: true });
}

// workReturned does not expire a preparation if no tick pruned it first.
{
	const agent = createAlwaysOnAgent({ llm: scripted(() => thought("検証用")), tools });
	agent.observe(user("ttl-user", 0, "検証用の調査依頼"));
	const { ticket } = agent.requestPrepare({ toolName: "probe_reader", toolInput: "検証用の調査", at: 0 });
	assert.ok(ticket);
	agent.recordResult({ ticketId: ticket.id, status: "succeeded", at: 1 });
	const returned = agent.workReturned({ ticketId: ticket.id, at: PREPARING_TTL_MS + 1, status: "succeeded", summary: "検証用の期限後結果" });
	assert.ok(returned);
	assert.equal(agent.view().stock.length, 1);
	results.push({ id: "AO-N3", expectedAfterFix: "tickの有無に関係なく6時間を超えた返却を採用しない",
		observed: { expiredReturnAccepted: true, findings: agent.view().stock.length }, contractGapReproduced: true });
}

// The requested-preparation API captures only the latest user observation, not offered tool sources.
{
	const agent = createAlwaysOnAgent({ llm: scripted(() => thought("検証用")), tools });
	agent.observe(user("request-A", 0, "Aの依頼"));
	agent.observe(user("request-B", 1, "独立したBの発言"));
	const { ticket } = agent.requestPrepare({ toolName: "probe_reader", toolInput: "Aの依頼を処理", at: 2 });
	assert.ok(ticket);
	assert.deepEqual(ticket.inputs, ["request-B"]);
	assert.ok(!ticket.inputs.includes("capability:probe-revision"));
	results.push({ id: "AO-N4", expectedAfterFix: "通常応答のrun・入力版と能力等の依存元を明示し、古いrunからの受付を拒否する",
		observed: { boundToLatestUser: "request-B", toolSourceMissing: true, apiAcceptsExpectedRunOrMessage: false }, contractGapReproduced: true });
}

assert.deepEqual(fingerprints(), before, "source changed during the probes; repeat against a fixed source");
process.stdout.write(JSON.stringify({ kind: "scripted-contract-investigation", upstreamVersion: ALWAYS_ON_VERSION,
	sourceFiles: before, providerCalls: 0, productDatabaseAccess: false, serverOperations: false,
	meaningQualityEvaluated: false, note: "4件の契約不足の再現であり、製品受入の合格ではない", results }, null, 2) + "\n");
