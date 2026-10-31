import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCodexTurn } from "../adapters/codex-app-server";
import { codexUsage } from "../adapters/codex-usage";
import { cloudRequest, type CloudEnv } from "../service/cloud";
import type { RequestRow } from "../repository";
import type { Connection, Resource } from "../../settings";

test("whole ephemeral thread totals include every upstream completion; last and duplicates are not added", async () => {
	const dir = await mkdtemp(join(tmpdir(), "usage-codex-"));
	const command = join(dir, "fixture");
	await writeFile(
		command,
		`#!${process.execPath}
import { createInterface } from "node:readline";
const out = (m) => process.stdout.write(JSON.stringify(m)+"\\n");
createInterface({input:process.stdin}).on("line",line=>{
const m=JSON.parse(line);
if(m.method==="initialize")out({id:m.id,result:{}});
if(m.method==="thread/start")out({id:m.id,result:{thread:{id:"t"}}});
if(m.method==="turn/start"){
out({id:m.id,result:{turn:{id:"u"}}});
for(const [threadId,turnId,n] of [["other","u",9999],["t","other",9999],["t","u",100],["t","u",250],["t","u",250],["t","u",100]]){
const part={inputTokens:n,outputTokens:n/10,cachedInputTokens:n/2,cacheWriteInputTokens:0,reasoningOutputTokens:n/25};
out({method:"thread/tokenUsage/updated",params:{threadId,turnId,tokenUsage:{total:part,last:{...part,inputTokens:7}}}});
}
out({method:"model/rerouted",params:{threadId:"t",turnId:"u",fromModel:"fixture-a",toModel:"fixture-b"}});
out({method:"item/completed",params:{threadId:"t",item:{type:"agentMessage",text:"ok"}}});
out({method:"turn/completed",params:{threadId:"t",turn:{id:"u",status:"completed"}}});
}});
`,
		{ mode: 0o700 },
	);
	try {
		const observations: unknown[] = [];
		const result = await runCodexTurn(
			{ command, env: {} },
			{
				cwd: dir,
				model: "fixture-a",
				instructions: "",
				prompt: "",
				signal: AbortSignal.timeout(5000),
				onUsage: (u) => observations.push(u),
			},
			(s) => new Error(s),
		);
		expect(result).toMatchObject({
			text: "ok",
			inputTokens: 250,
			outputTokens: 25,
			cacheReadTokens: 125,
			reasoningTokens: 10,
			usageModel: null,
		});
		expect(observations).not.toHaveLength(0);
		expect(
			codexUsage(
				{ total: { inputTokens: 100, outputTokens: -1 } },
				"fixture-a",
			),
		).toBeNull();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("usage writes drain even when the SDK turn fails after reporting cumulative usage", async () => {
	const saved: unknown[][] = [];
	const env: CloudEnv = {
		store: {
			write: async (fn: (db: unknown) => unknown) => {
				await Bun.sleep(5);
				return fn({
					query: () => ({ run: (...args: unknown[]) => saved.push(args) }),
				});
			},
		} as unknown as CloudEnv["store"],
		settings: { credential: () => null },
		agents: {
			async run(call) {
				call.onUsage?.({
					inputTokens: 1000,
					outputTokens: 100,
					cacheReadTokens: 400,
					cacheCreationTokens: 0,
					reasoningTokens: 20,
					usageModel: call.model,
				});
				throw new Error("fixture_failed");
			},
		},
	};
	const connection: Connection = {
		id: "c",
		name: "SDK",
		kind: "codex-sdk",
		enabled: true,
		epoch: 0,
		envRef: null,
		baseUrl: "https://example.test",
	};
	const resource: Resource = {
		id: "r",
		connectionId: "c",
		purpose: "llm",
		model: "fixture-a",
		contextWindow: 10000,
		voice: null,
	};
	await expect(
		cloudRequest(
			env,
			{ purpose: "llm", contextPolicy: "exact" } as RequestRow,
			[{ role: "user", content: "go" }],
			connection,
			resource,
			AbortSignal.timeout(1000),
			"attempt",
		),
	).rejects.toThrow("fixture_failed");
	expect(saved).toHaveLength(1);
	expect(saved[0]!.slice(0, 4)).toEqual([1000, 100, 400, 0]);
});
