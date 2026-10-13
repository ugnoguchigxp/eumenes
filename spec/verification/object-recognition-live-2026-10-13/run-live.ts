import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { loadProcessConfig } from "../../../api/infrastructure/config";
import { readApiToken } from "../../../api/infrastructure/auth-config";
import { readStoredLarm } from "../../../api/domains/settings";
import { createTransport } from "../../../client/transport";
import { objectRecognitionClient } from "../../../client/object-recognition";
import { dialogueClient } from "../../../client/dialogue";
import { conversationClient } from "../../../client/conversation";
import type { RecognitionRecord } from "../../../api/domains/object-recognition/contracts";

const dir = import.meta.dir;
const path = resolve(dir, "live-result.json");
const config = loadProcessConfig();
const saved = readStoredLarm(config.dbPath);
const transport = createTransport(`http://127.0.0.1:${config.port}`, readApiToken(process.env));
const requests: unknown[] = [];
const tracked = { ...transport, call: async (path: string, init?: RequestInit) => {
	const r = await transport.call(path, init);
	if ((init?.method ?? "GET") !== "GET") requests.push({path, method:init?.method, status:r.status, requestId:r.headers.get("X-Request-Id")});
	return r;
}};
const client = {...objectRecognitionClient(tracked), ...dialogueClient(tracked), ...conversationClient(tracked)};
let report: Record<string, any>;
try { report = JSON.parse(readFileSync(path, "utf8")); }
catch { report = { fixture: false, physicalCamera: "not_run", conversationId: "object-recognition-live-2026-10-13", stages: {} }; }
const stage = process.argv[2] ?? "image";
const started = Date.now();
const trace: unknown[] = [];
const digest = (bytes: ArrayBuffer) => createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
async function status() {
	const headers = {Authorization:`Bearer ${config.larmToken}`};
	const r = await fetch(new URL("/v1/local-services", saved.baseUrl!), {headers, redirect:"error", signal:AbortSignal.timeout(10000)});
	assert.equal(r.status, 200);
	const b = await r.json();
	return b.services.filter((s: any) => ["object-recognition-host", "ocr-host"].includes(s.id)).map((s: any) => ({id:s.id, revision:s.revision, generation:s.generation, state:s.state, busy:s.busy, activityFresh:s.activityFresh}));
}
async function input(name: string) {
	const f = Bun.file(resolve(dir, name));
	return new File([await f.arrayBuffer()],name,{type:name.endsWith("jpg")?"image/jpeg":"video/mp4"});
}
function observe(record: RecognitionRecord) {
	const value = {at:new Date().toISOString(),state:record.state,progress:record.progress,errorCode:record.errorCode};
	const last = trace.at(-1) as typeof value | undefined;
	if (!last || last.state !== value.state || JSON.stringify(last.progress) !== JSON.stringify(value.progress)) trace.push(value);
}
async function terminal(record: RecognitionRecord) {
	const deadline = Date.now() + 180000;
	while (["queued","starting","running","cancelling"].includes(record.state) && Date.now()<deadline) {
		observe(record);
		await Bun.sleep(250);
		record = await client.recognitionGet(record.id);
	}
	observe(record);
	return record;
}
function save(value: unknown) {
	report.stages[stage] = value;
	writeFileSync(path,JSON.stringify(report,null,2));
	console.log(JSON.stringify({stage,...value as object}));
}
try {
	const connection = await client.recognitionConnection();
	assert.equal(connection.credentialSource,"larm");
	assert.equal(connection.credentialConfigured,true);
	assert.equal(connection.baseUrl,"http://127.0.0.1:18796");
	if (stage === "image" || stage === "video" || stage === "cancel" || stage === "cold-restart") {
		const before = await status();
		if(stage === "cold-restart") assert.equal(before.find((s:any)=>s.id==="object-recognition-host")?.state,"stopped");
		const file = await input(stage === "video"?"bus-3s.mp4":stage === "cancel"?"bus-29s.mp4":"bus.jpg");
		let record = await client.recognitionUpload(file,report.conversationId,crypto.randomUUID());
		report.ids ??= {};
		report.ids[stage] = record.id;
		// Persist the durable Eumenes id before any wait. Never replay the analyze POST.
		writeFileSync(path,JSON.stringify(report,null,2));
		if (stage === "cancel") {
			for(let i=0;i<400 && record.state==="queued";i++) {await Bun.sleep(25);record=await client.recognitionGet(record.id);}
			assert.ok(["starting","running"].includes(record.state),"upstream_analysis_started_before_cancel");
			observe(record);
			record = await client.recognitionCancel(record.id);
		}
		record = await terminal(record);
		writeFileSync(resolve(dir,`${stage}-record.json`),JSON.stringify(record,null,2));
		if(stage === "cancel") {
			assert.equal(record.state,"cancelled");
			assert.equal(record.result,null);
		} else {
			assert.equal(record.state,"completed", record.errorCode??"recognition_not_completed");
			assert.ok(record.result);
			assert.match(record.result.model,/yolo26n/i);
			const objects=record.result.kind==="image"?record.result.objects:record.result.frames.flatMap(f=>f.objects);
			assert.ok(objects.some(o=>o.label==="bus"));
			assert.ok(objects.some(o=>o.label==="person"));
			if(stage === "video") {
				assert.equal(record.result.kind,"video");
				if(record.result.kind==="video") assert.deepEqual(record.result.frames.map(f=>f.timestampSeconds),[0,0.5,1,1.5,2,2.5]);
			}
			const source=await client.recognitionContent(record.id);
			assert.equal(digest(await source.arrayBuffer()),digest(await file.arrayBuffer()));
		}
		const after=await status();
		if(stage === "cold-restart") assert.ok(after.find((s:any)=>s.id==="object-recognition-host")?.generation > before.find((s:any)=>s.id==="object-recognition-host")?.generation);
		save({outcome:"passed",at:new Date().toISOString(),durationMs:Date.now()-started,id:record.id,state:record.state,errorCode:record.errorCode,model:record.result?.model,frameCount:record.result?.kind==="video"?record.result.frames.length:undefined,objects:record.result?.kind==="image"?record.result.objects.map(o=>({label:o.label,box:o.box,confidence:o.confidence})):undefined,trace,before,after,requests});
	} else if(stage === "recovery") {
		const records=await client.recognitionRecords(report.conversationId);
		assert.ok(records.some(r=>r.id===report.ids.image&&r.state==="completed"));
		assert.ok(records.some(r=>r.id===report.ids.video&&r.state==="completed"));
		assert.ok(records.some(r=>r.id===report.ids.cancel&&r.state==="cancelled"&&r.result===null));
		const source=await client.recognitionContent(report.ids.image);
		assert.equal(digest(await source.arrayBuffer()),digest(await(await input("bus.jpg")).arrayBuffer()));
		save({outcome:"passed",at:new Date().toISOString(),connection,recordCount:records.length,sourceVerified:true});
	} else if(stage === "idle") {
		const samples: unknown[] = [];
		let services = await status();
		const deadline=Date.now()+180000;
		while(services.find((s:any)=>s.id==="object-recognition-host")?.state!=="stopped" && Date.now()<deadline) {
			samples.push({at:new Date().toISOString(),services});
			await Bun.sleep(3000);
			services=await status();
		}
		samples.push({at:new Date().toISOString(),services});
		assert.equal(services.find((s:any)=>s.id==="object-recognition-host")?.state,"stopped");
		assert.equal(services.find((s:any)=>s.id==="ocr-host")?.state,"stopped");
		save({outcome:"passed",at:new Date().toISOString(),statusGetOnly:true,samples});
	} else if(stage === "status") {
		save({outcome:"observed",at:new Date().toISOString(),services:await status()});
	} else if(stage === "incorporate") {
		const run=await client.recognitionIncorporate(report.ids.video,crypto.randomUUID(),2);
		report.runId=run.id;
		writeFileSync(path,JSON.stringify(report,null,2));
		let current=await client.run(run.id);
		for(let i=0;i<180&&["queued","running"].includes(current.status);i++) {await Bun.sleep(1000);current=await client.run(run.id);}
		assert.equal(current.status,"completed");
		const conversation=await client.conversation(report.conversationId);
		assert.ok(conversation.messages.some(m=>m.text.includes("bus")&&m.text.includes("person")&&m.text.includes("1秒")));
		save({outcome:"passed",at:new Date().toISOString(),runId:run.id,status:current.status,observationsSaved:true,requests});
	} else throw new Error("unknown_live_stage");
} catch(error) {
	// No raw upstream body, request headers, environment, or credential enters evidence.
	const e = error as {name?:string;status?:number;requestId?:string};
	save({outcome:"failed",at:new Date().toISOString(),durationMs:Date.now()-started,errorType:e.name,httpStatus:e.status,requestId:e.requestId,trace,requests});
	process.exitCode=1;
}
