import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexResearch } from "../../domains/inference";
import { harness } from "./toolchain.fixture";

const finish =
	"{action:'finish',report:{completion:'incomplete',answer:'検索範囲では必要な根拠なし',summary:'検索範囲では必要な根拠なし',claims:[],limitations:[],},}";
for (const scenario of [
	{
		name: "corrected syntax reaches search and finish without a model repair",
		outputs: [
			"{action:'invoke',tool:'web.lookup',arguments:{query:'公開情報'},}",
			finish,
		],
		searches: 1,
		state: "completed",
		repairs: 0,
		error: null,
	},
	{
		name: "duplicate actions stop after one repair without executing either action",
		outputs: [
			"{action:'invoke',action:'finish',tool:'web.lookup',arguments:{query:'公開情報'},}",
		],
		searches: 0,
		state: "failed",
		repairs: 1,
		error: "invalid_control_json",
	},
	{
		name: "corrected syntax cannot authorize an unoffered tool",
		outputs: [
			"{action:'invoke',tool:'unoffered',arguments:{query:'公開情報'},}",
		],
		searches: 0,
		state: "failed",
		repairs: 1,
		error: "invalid_tool_input",
	},
	{
		name: "corrected syntax cannot invent evidence references",
		outputs: [
			"{action:'invoke',tool:'web.lookup',arguments:{query:'公開情報'},}",
			"{action:'finish',report:{completion:'complete',answer:'未取得の事実',summary:'未取得の事実',claims:[{text:'未取得の事実',status:'verified',evidence:['e999']}],limitations:[],},}",
		],
		searches: 1,
		state: "failed",
		repairs: 1,
		error: "invalid_evidence",
	},
])
	test(`actual SDK and shared host guards: ${scenario.name}`, async () => {
		const dir = await mkdtemp(join(tmpdir(), "eumenes-sdk-json-"));
		const command = join(dir, "codex");
		const counter = join(dir, "calls.json");
		await writeFile(
			command,
			`#!${process.execPath}
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const counter = ${JSON.stringify(counter)};
const count = existsSync(counter) ? JSON.parse(readFileSync(counter, "utf8")) : 0;
writeFileSync(counter, JSON.stringify(count + 1));
const outputs = ${JSON.stringify(scenario.outputs)};
console.log(JSON.stringify({type:"item.completed", item:{type:"agent_message", text:outputs[Math.min(count, outputs.length - 1)]}}));
console.log(JSON.stringify({type:"turn.completed",usage:{}}));
`,
			{ mode: 0o700 },
		);
		const h = await harness({
			fullResearch: true,
			codexResearch: createCodexResearch({ HOME: dir, PATH: "" }, command),
		});
		try {
			const run = await h.dialogue.submit({
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text: "公開情報を調べて。",
			});
			expect(
				(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 10000 }))
					?.status,
			).toBe("completed");
			const child = h.toolchain.agents
				.list(run.id)
				.find((t) => t.kind === "worker")!;
			const state = h.store.read((db) =>
				db
					.query(
						"SELECT state,json_repairs,model_calls,error_code,control_repair_json FROM agent_tasks WHERE id=?",
					)
					.get(child.id),
			) as {
				state: string;
				json_repairs: number;
				model_calls: number;
				error_code: string | null;
				control_repair_json: string | null;
			};
			expect(state).toMatchObject({
				state: scenario.state,
				json_repairs: scenario.repairs,
				model_calls: scenario.error === "invalid_evidence" ? 3 : 2,
				error_code: scenario.error,
			});
			expect(h.acquisitions).toBe(scenario.searches);
			expect(JSON.parse(await readFile(counter, "utf8"))).toBe(
				scenario.error === "invalid_evidence" ? 3 : 2,
			);
			if (scenario.state === "completed")
				expect(h.toolchain.agents.report(child.id)?.version).toBe(2);
			else
				expect(() => h.toolchain.agents.report(child.id)).toThrow(
					"report_not_ready",
				);
			if (scenario.error === "invalid_control_json")
				expect(JSON.parse(state.control_repair_json!)).toMatchObject([
					{ validationCode: "llm_json_duplicate_key" },
				]);
		} finally {
			await h.close();
			await rm(dir, { recursive: true, force: true });
		}
	}, 15000);
