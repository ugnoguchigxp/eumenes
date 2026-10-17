/** Backend evaluation: frozen API context + accepted worker payload; no server or product writes. */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createClient } from "../client";
import { readApiToken } from "../api/infrastructure/auth-config";
import { readStoredReportProjection } from "../api/domains/agent-runtime";
import { CONVERSATION_HOST_RULES, type ContextAssembly } from "../api/domains/dialogue/service/context-assembly";
import { researchResultBlock } from "../api/domains/dialogue/service/context-blocks";
import { renderContext } from "../api/domains/dialogue/service/context-render";
import { markCurrentRequest } from "../api/domains/dialogue/service/request-context";
import { generateConversation } from "../api/domains/dialogue/service/conversation-generation";
import { researchCitations } from "../api/domains/dialogue/service/research-citations";
import { createLiveLarm } from "./live-larm";

const arg = (name: string) => {
	const index = process.argv.indexOf(name);
	return index < 0 ? undefined : process.argv[index + 1];
};
const fixturePath = resolve(arg("--fixture") ?? "verification-reports/persona-answer/frozen.json");
const digest = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");
const save = (path: string, value: unknown) => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
};
if (process.argv.includes("--freeze")) {
	const c = createClient(process.env.EUMENES_URL ?? "http://127.0.0.1:8787", readApiToken(process.env, resolve("data/eumenes.sqlite3")));
	const [settings, conversation, memory] = await Promise.all([c.settings(), c.conversation("main"), c.memoryContext("main")]);
	if (memory.disabled) throw new Error("memory_unavailable");
	const runId = "d99b4415-8567-46dd-9fd7-e5d88435099f";
	const request = conversation.messages.find(m => m.runId === runId && m.role === "user");
	const reply = conversation.messages.find(m => m.runId === runId && m.role === "assistant");
	if (!request || !reply) throw new Error("recorded_run_missing");
	const saved = readStoredReportProjection(process.env.EUMENES_DB ?? "./data/eumenes.sqlite3", "eb2c1e80-a677-48a6-a85b-d3f7127ab6e6");
	if (!saved) throw new Error("projection_missing");
	const stable: ContextAssembly["stable"] = [{source:"memory.long_term",authority:"reference",freshness:"stable",certainty:"remembered",body:{kind:"lines",sections:[{items:[memory.longTerm.text]}]}}];
	const working: ContextAssembly["working"] = [{source:"memory.short_term",authority:"reference",freshness:"past",certainty:"remembered",body:{kind:"text",text:memory.shortTerm.text}}];
	const assembly: ContextAssembly = {stage:"result", persona:settings.general,hostRules:CONVERSATION_HOST_RULES, stable,working,history:{turns:conversation.messages.filter(m=>m.createdAt<request.createdAt).map(m=>({role:m.role as "user"|"assistant", content:m.text,messageId:m.id,at:m.createdAt,layer:"keep"}))},volatile:[researchResultBlock(JSON.parse(saved.projection), Date.parse(reply.createdAt))],input:{role:"user",content:request.text}};
	save(fixturePath,{note:"Exact saved worker projection; actual earlier history and current API memory, not the historical memory snapshot. No persisted settings changed.",runId,requestId:request.id,projection:saved,assembly});
	console.log(JSON.stringify({frozen:fixturePath,history:assembly.history.turns.length,memoryVersion:memory.version,workerAnswer:JSON.parse(saved.projection).answer}));
} else {
	if (!process.argv.includes("--run") || !process.argv.includes("--out")) throw new Error("Pass --run --out <new-file>");
	const fixture = JSON.parse(readFileSync(fixturePath,"utf8")) as {assembly:ContextAssembly;requestId:string;projection:{projection:string};note:string};
	const chosen = process.argv.includes("--case") ? arg("--case") : undefined;
	const results: Array<{id:string;passed:boolean;[key:string]:unknown}> = [];
	const live = createLiveLarm();
	try {
		await live.connect();
		for (const id of ["weather","memory-comparison","sage","repair"]) {
			if (chosen && chosen !== id) continue;
			const a = structuredClone(fixture.assembly);
			if (id === "sage") a.persona.persona="sage";
			if (id === "memory-comparison") a.input={role:"user",content:"今回の鎌倉の予報と、直前に聞いた静岡の予報の最高気温を短く比べて。"};
			const rendered = renderContext(a,"current");
			const messages = markCurrentRequest(rendered.messages,a.input,fixture.requestId);
			const attempts: Array<{origin:string;text:string}> = [];
			let repairs=0;
			const inference = {answer:async (...args:Parameters<typeof live.answer>)=>{
				const forced=id==="repair" && !attempts.length;
				const text=forced ? JSON.parse(fixture.projection.projection).answer as string : await live.answer(...args);
				attempts.push({origin:forced?"forced-long-worker-draft":"live",text});
				return text;
			}};
			try {
				const result=await generateConversation({inference,messages,requestMessage:a.input,signal:AbortSignal.timeout(90000),delta:()=>{},briefReply:true,repair:()=>{repairs++;},sessionRole:"main"});
				const text=researchCitations(result.text,fixture.projection.projection,{requireSources:true});
				const passed=/24℃/.test(text) && (id!=="memory-comparison" || /26℃/.test(text)) && (id==="sage" ? /じゃ|のう|であろう|なさい/.test(result.text) : !/と見ます|結論から|推奨します|じゃ|のう/.test(result.text)) && (id!=="repair" || repairs===1);
				results.push({id,passed,text,repairs,attempts,inputDigest:digest(messages),historyCount:rendered.sessionContext.historyCount,persona:a.persona.persona});
			} catch(error) {
				results.push({id,passed:false,error:error instanceof Error?error.message:"error",repairs,attempts,inputDigest:digest(messages)});
			}
			console.log(JSON.stringify({id,passed:results.at(-1)!.passed,repairs}));
		}
	} finally {await live.close();}
	if (!results.length) throw new Error("no_cases_selected");
	save(resolve(arg("--out")!),{fixture:fixturePath,fixtureDigest:digest(fixture),note:fixture.note,results});
	if(results.some(r=>!r.passed))process.exitCode=1;
}
