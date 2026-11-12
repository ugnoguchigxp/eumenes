import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexHost } from "../adapters/codex-host";
import type { ThreadMessage } from "../adapters/codex-threads";
import { codexUsage } from "../adapters/codex-usage";
import { codexCall, fakeCodex, user } from "./codex.fixture";
import { cloudRequest, type CloudEnv } from "../service/cloud";
import type { RequestRow } from "../repository";
import type { Connection, Resource } from "../../settings";

test("a turn's usage is the thread total less the total at its start; last and duplicates are not added", async () => {
	const dir = await mkdtemp(join(tmpdir(), "usage-codex-"));
	const command = join(dir, "fixture");
	await writeFile(
		command,
		`#!${process.execPath}
import { createInterface } from "node:readline";
const out = (m) => process.stdout.write(JSON.stringify(m)+"\\n");
let turns = 0;
createInterface({input:process.stdin}).on("line",line=>{
const m=JSON.parse(line);
if(m.method==="initialize")out({id:m.id,result:{}});
if(m.method==="thread/start")out({id:m.id,result:{thread:{id:"t"}}});
if(m.method==="turn/start"){
const base = turns++ * 1000;
out({id:m.id,result:{turn:{id:"u"+turns}}});
const turnId = "u"+turns;
for(const [threadId,id,n] of [["other",turnId,9999],["t","other",9999],["t",turnId,base+100],["t",turnId,base+250],["t",turnId,base+250],["t",turnId,base+100]]){
const part={inputTokens:n,outputTokens:n/10,cachedInputTokens:n/2,cacheWriteInputTokens:0,reasoningOutputTokens:n/25};
out({method:"thread/tokenUsage/updated",params:{threadId,turnId:id,tokenUsage:{total:part,last:{...part,inputTokens:7}}}});
}
if(turns===1)out({method:"model/rerouted",params:{threadId:"t",turnId,fromModel:"fixture-a",toModel:"fixture-b"}});
out({method:"item/completed",params:{threadId:"t",turnId,item:{type:"agentMessage",text:"ok"}}});
out({method:"turn/completed",params:{threadId:"t",turn:{id:turnId,status:"completed"}}});
}});
`,
		{ mode: 0o700 },
	);
	const host = createCodexHost(
		{ PATH: "" },
		{ executable: command, home: join(dir, "home") },
	)!;
	try {
		const run = async (messages: ThreadMessage[]) => {
			const observations: unknown[] = [];
			const result = await host.run(
				{ credential: null, baseUrl: "https://example.test" },
				{
					model: "fixture-a",
					instructions: "",
					messages,
					input: () => ({ prompt: "p", images: [] }),
					reasoningEffort: "high",
					signal: AbortSignal.timeout(5000),
					onUsage: (u) => observations.push(u),
				},
			);
			return { result, observations };
		};
		const first = await run([{ digest: "a", assistant: false }]);
		expect(first.result).toMatchObject({
			text: "ok",
			inputTokens: 250,
			outputTokens: 25,
			cacheReadTokens: 125,
			reasoningTokens: 10,
			usageModel: null,
		});
		expect(first.observations).not.toHaveLength(0);
		// The same thread continued: the total began this turn at 250 / 25 / 125 / 10 and the turn added the rest.
		const second = await run([
			{ digest: "a", assistant: false },
			{ digest: "b", assistant: true },
			{ digest: "c", assistant: false },
		]);
		expect(second.result).toMatchObject({
			inputTokens: 1250 - 250,
			outputTokens: 125 - 25,
			cacheReadTokens: 625 - 125,
			reasoningTokens: 50 - 10,
			usageModel: "fixture-a",
		});
		expect(
			codexUsage(
				{ total: { inputTokens: 100, outputTokens: -1 } },
				"fixture-a",
			),
		).toBeNull();
		// A total below the start of the turn is not a usage.
		expect(
			codexUsage(
				{ total: { inputTokens: 100, outputTokens: 10 } },
				"fixture-a",
				{ input: 200, output: 0, cached: 0, cacheWrite: 0, reasoning: 0 },
			),
		).toBeNull();
	} finally {
		await host.close();
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

test("native Web search is isolated and requires a completed search in the current turn", async () => {
	const codex = await fakeCodex();
	try {
		const agents = codex.agents(codex.host());
		const run = (nativeWebSearch?: true) =>
			agents.run(codexCall([user("public lookup")], { nativeWebSearch }));
		expect((await run()).text).toBe("answer");
		await codex.behave({ search: "other" });
		await expect(run(true)).rejects.toThrow("cloud_agent_web_search_missing");
		await codex.behave({ search: "this" });
		expect((await run(true)).text).toBe("answer");
		const argv = (await codex.of("spawn")).map((r) => r.params.argv.join(" "));
		expect(argv).toHaveLength(2);
		expect(argv[0]).toContain('web_search="disabled"');
		expect(argv[1]).toContain('web_search="live"');
	} finally {
		await codex.cleanup();
	}
});
