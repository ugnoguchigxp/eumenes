import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createPrototypeService } from "../../../api/domains/prototype";
import { buildWorksWeb, serveWorksWeb } from "../instant-project-sandbox-p2-2026-11-28/web";

const core = realpathSync(resolve(import.meta.dir, "../../.."));
const bun = process.execPath;
const previewProbe = () => Bun.serve({ hostname:"127.0.0.1", port:0, fetch:()=>new Response("pending",{status:503}) });
async function reserve() {
	const p = previewProbe(); const port = p.port!;
	await p.stop(true);
	return port;
}
if (process.argv[2]==="--host") {
	const [tmp, home, works, previewRaw, web] = process.argv.slice(3) as [string,string,string,string,string];
	const previewPort=Number(previewRaw), data=join(tmp,"data");
	mkdirSync(data);
	let fetchRequest:(request:Request)=>Response|Promise<Response>|undefined = () => new Response("pending",{status:503});
	let view:ReturnType<typeof createPrototypeService>;
	const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch(request) {
		const target=new URL(request.url).pathname;
		if(target==="/_measure") return Response.json(view?.metrics());
		return fetchRequest(request) ?? new Response("missing",{status:404});
	}});
	const origin="http://127.0.0.1:"+server.port;
	const stopping=Promise.withResolvers<void>();
	process.once("SIGTERM",stopping.resolve);
	process.once("SIGINT",stopping.resolve);
	try {
		view=createPrototypeService({core,data,works,runtime:home,defaultVersion:"3.0",parentOrigin:origin,previewPort});
		fetchRequest=serveWorksWeb({core,temp:tmp,origin,previewPort,works:view},web);
		console.log(origin);
		await stopping.promise;
	} finally {
		await view!?.close();
		await server.stop(true);
	}
	process.exit(0);
}

const browser = await chromium.launch({channel:"chrome", args:["--mute-audio","--no-proxy-server"]});
const browserDebug=await browser.newBrowserCDPSession();
const path = realpathSync(mkdtempSync(join(tmpdir(),"works-p4-runtime-")));
const env = {PATH:process.env.PATH,HOME:path,TMPDIR:path};
const starts = new Set<ReturnType<typeof Bun.spawn>>();
const ports = new Set<number>();
const command = async (args:string[], cwd=core) => {
	const child=Bun.spawn(args,{cwd,env,stdout:"pipe",stderr:"pipe"});
	const [rc,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
	assert.equal(rc,0,err);
	return out.trim();
};
const tool = (...args:string[]) => command([bun,"--no-env-file","scripts/works-runtime.ts",...args]);
const git = (cwd:string,...args:string[]) => command(["/usr/bin/git","-c","core.hooksPath=/dev/null",...args],cwd);
async function commit(cwd:string) {
	await git(cwd,"init","-q"); await git(cwd,"add",".");
	await git(cwd,"-c","user.email=works-test@example.invalid","-c","user.name=Works Benchmark","commit","-qm","fixture");
}
const elapsed=(since:number)=>Math.round(performance.now()-since);
const baseline = JSON.parse(readFileSync(join(core,"api/domains/prototype/runtime/dependencies.json"),"utf8"));
baseline.name="works-vite-measurement";
baseline.devDependencies.vite="8.3.5";
const fixture = (title:string) => `
import React from "react";
import { createRoot } from "react-dom/client";
import { MathUtils } from "three";
import { Vec3 } from "cannon-es";
const host = document.getElementById("app")!;
let root = (host as HTMLDivElement & {worksRoot?: ReturnType<typeof createRoot>}).worksRoot;
if (!root) {
 root = createRoot(host);
 (host as HTMLDivElement & {worksRoot?: ReturnType<typeof createRoot>}).worksRoot = root;
}
root.render(<h1>${title} {MathUtils.clamp(new Vec3(2,0,0).length(),0,10)}</h1>);
(import.meta as ImportMeta & {hot?:{accept():void}}).hot?.accept();
`;
function sources(folder:string,title:string,mode:string) {
	mkdirSync(join(folder,"src"),{recursive:true});
	writeFileSync(join(folder,"src/main.tsx"),fixture(title));
	if(mode==="works")
		writeFileSync(join(folder,"prototype.json"),JSON.stringify({schema:1,name:title,entry:"src/main.tsx",environment:"3.0",features:[],include:["src"]}));
	else {
		writeFileSync(join(folder,"package.json"),JSON.stringify(baseline));
		writeFileSync(join(folder,"index.html"),'<!doctype html><meta charset="utf-8"><div id="app"></div><script type="module" src="/src/main.tsx"></script>');
	}
}
async function child(args:string[], cwd=core) {
	const p=Bun.spawn(args,{cwd,env,stdout:"pipe",stderr:"inherit"});
	starts.add(p);
	return p;
}
async function stop(p:ReturnType<typeof Bun.spawn>) {
	if(p.exitCode===null) p.kill("SIGTERM");
	await p.exited;
	starts.delete(p);
}
function memory(pids:number[]) {
	if(!pids.length) return 0;
	const queried=Bun.spawnSync(["/usr/bin/footprint","--noCategories","-f","bytes",...pids.flatMap(pid=>["-p",String(pid)])],{stderr:"pipe"});
	const bytes=Array.from(queried.stdout.toString().matchAll(/^\s*phys_footprint:\s*(\d+) B/gm), m=>Number(m[1]));
	const own=Array.from(queried.stdout.toString().matchAll(/^.* \[(\d+)\]:.* Footprint:/gm),m=>Number(m[1]));
	assert.equal(bytes.length,pids.length,JSON.stringify({pids,own,stderr:queried.stderr.toString()}));
	return bytes.reduce((sum,value)=>sum+value,0);
}
function snapshots(parent:number) {
	const result=Bun.spawnSync(["/usr/bin/pgrep","-P",String(parent)],{stderr:"ignore"});
	return result.stdout.toString().trim().split(/\s+/).filter(Boolean).map(Number);
}
async function browserFootprint() {
	const {processInfo}=await browserDebug.send("SystemInfo.getProcessInfo");
	return memory(processInfo.map((item:{id:number})=>item.id));
}
async function up(url:string) {
	for(let i=0;i<350;i++) {
		try {if((await fetch(url)).ok) return;} catch {}
		await Bun.sleep(75);
	}
	throw new Error("not ready: "+url);
}
async function printedUrl(p:ReturnType<typeof Bun.spawn>) {
	const reader=(p.stdout as ReadableStream<Uint8Array>).getReader();
	try {
		let contents="";
		while(!contents.includes("\n")) {
			const next=await reader.read(); assert(!next.done,contents);
			contents+=new TextDecoder().decode(next.value);
		}
		return contents.split("\n")[0]!.trim();
	} finally {reader.releaseLock();}
}
const install=(cwd:string,cache:string, frozen=true)=>command([bun,"--no-env-file","install","--ignore-scripts","--backend=clonefile","--cache-dir="+cache,...(frozen?["--frozen-lockfile"]:[])],cwd);
const result:Record<string, unknown[]>={cold:[],primed:[]};
const trials=Number(process.argv[2]??"3");
assert(Number.isInteger(trials)&&trials>0&&trials<=5);
console.error("Preparing frozen sources");
try {
	const seed=join(path,"source"), baseSeed=join(path,"vite-seed");
	sources(baseSeed,"Seed","vite");
	await install(baseSeed,join(path,"vite-lock-cache"),false);
	const lock=readFileSync(join(baseSeed,"bun.lock"));
	await tool("export",seed); await commit(seed); await git(seed,"tag","works-v3.0");
	const pin=JSON.parse(await tool("pin",seed,"3.0"));
	const web=await buildWorksWeb({core,temp:path});
	for(const mode of ["cold","primed"] as const) for(let i=0;i<trials;i++) {
		console.error(mode+" "+(i+1)+"/"+trials);
		const dir=join(path,mode+i), home=join(dir,"shared"), works=join(dir,"works"), hostDir=join(dir,"host"), cache=join(dir,"vite-cache");
		for(const p of [home,works,hostDir]) mkdirSync(p,{recursive:true});
		if(mode==="primed") {
			await install(baseSeed,cache);
			await install(seed,join(home,"cache"));
		}
		const prepAt=performance.now();
		await tool("install",home,seed,"3.0",pin.commit,pin.digest);
		const prepareMs=elapsed(prepAt);

		const context = await browser.newContext();
		const both:Record<string,unknown>={};
		const baselineTitle = (j:number) => ["First","Second"][j]!;
		const baselinePages=[];
		const baselineServers=[];
		const baselineTimes=[];
		const baselinePorts:number[]=[];
		const baselineMemory=[0], browserBaseline=[await browserFootprint()];
		for(let j=0;j<2;j++) {
			const folder=join(dir,"vite"+j), title=baselineTitle(j);
			sources(folder,title,"vite"); writeFileSync(join(folder,"bun.lock"),lock);
			const port=await reserve(); ports.add(port); baselinePorts.push(port);
			const start=performance.now(); await install(folder,cache);
			const p=await child(["node",join(folder,"node_modules/vite/bin/vite.js"),"--host","127.0.0.1","--strictPort","--port",String(port)],folder);
			baselineServers.push(p);
			const url="http://127.0.0.1:"+port; await up(url);
			const page=await context.newPage(); baselinePages.push(page); await page.goto(url);
			await expect(page.getByRole("heading",{name:title+" 2"})).toBeVisible();
			baselineTimes.push(elapsed(start));
			await Bun.sleep(250);
			baselineMemory.push(memory(baselineServers.map(process=>process.pid)));
			browserBaseline.push(await browserFootprint());
		}
		const changeAt=performance.now(); writeFileSync(join(dir,"vite0/src/main.tsx"),fixture("First Edited"));
		await expect(baselinePages[0]!.getByRole("heading",{name:"First Edited 2"})).toBeVisible();
		const updateMs=elapsed(changeAt);
		const reopenAt=performance.now(); await baselinePages[0]!.close();
		const baselineReopen=await context.newPage(); await baselineReopen.goto("http://127.0.0.1:"+baselinePorts[0]);
		await expect(baselineReopen.getByRole("heading",{name:"First Edited 2"})).toBeVisible();
		const reopenMs=elapsed(reopenAt);
		await Promise.all([baselineReopen.close(),baselinePages[1]!.close()]);
		const baselineAfterClose=memory(baselineServers.map(process=>process.pid));
		both.separate={firstMs:baselineTimes[0],secondMs:baselineTimes[1],updateMs,reopenMs,physicalBytesByWorkCount:baselineMemory,
			browserBytesByWorkCount:browserBaseline,browserBytesBothPagesClosed:await browserFootprint(),
			physicalBytesBothPagesClosed:baselineAfterClose,serverPids:baselineServers.map(process=>process.pid),loopbackPorts:baselinePorts};
		for(const p of baselineServers) await stop(p);
		const separateSequentialPort=await reserve(); ports.add(separateSequentialPort);
		const secondFolder=join(dir,"vite1");
		const sequential=await child(["node",join(secondFolder,"node_modules/vite/bin/vite.js"),"--host","127.0.0.1","--strictPort","--port",String(separateSequentialPort)],secondFolder);
		await up("http://127.0.0.1:"+separateSequentialPort);
		const sequentialPage=await context.newPage(); await sequentialPage.goto("http://127.0.0.1:"+separateSequentialPort);
		await expect(sequentialPage.getByRole("heading",{name:"Second 2"})).toBeVisible();
		(both.separate as Record<string,unknown>).physicalBytesSecondAlone=memory([sequential.pid]);
		await sequentialPage.close(); await stop(sequential);

		const port=await reserve(); ports.add(port);
		const host=await child([bun,"--no-env-file",import.meta.path,"--host",hostDir,home,works,String(port),web]);
		const origin=await printedUrl(host); ports.add(Number(new URL(origin).port));
		const page=await context.newPage(); await page.goto(origin+"/#works");
		await expect(page.getByRole("heading",{name:"Works",exact:true})).toBeVisible();
		const mem=[memory([host.pid])], browserWorks=[await browserFootprint()], seen=new Set<number>();
		const shown:number[]=[];
		const metrics=()=>fetch(origin+"/_measure").then(r=>r.json());
		const sample=async () => {
			const pp=snapshots(host.pid);
			for(const id of pp) seen.add(id);
		};
		const frames = ["First","Second"].map(title=>page.frameLocator('iframe[title="'+title+'"]'));
		const row=(title:string)=>page.getByRole("list",{name:"登録済み作品"}).getByRole("listitem").filter({hasText:title});
		let registered=0;
		const watcherStates=[await metrics()];
		const sampleTimer=setInterval(()=>{void sample();},25);
		try {
			for(let j=0;j<2;j++) {
				const title=baselineTitle(j), folder=join(works,title);
				sources(folder,title,"works"); await commit(folder);
				await page.getByRole("textbox",{name:"既存作品のフォルダ"}).fill(folder);
				const start=performance.now();
				await page.getByRole("button",{name:"登録",exact:true}).click();
				await expect(row(title)).toBeVisible();
				if(j===0) registered=memory([host.pid]);
				await row(title).getByRole("button",{name:"開く"}).click();
				await expect(frames[j]!.getByRole("heading",{name:title+" 2"})).toBeVisible();
				shown.push(elapsed(start)); await Bun.sleep(260);
				watcherStates.push(await metrics()); mem.push(memory([host.pid]));
				browserWorks.push(await browserFootprint());
			}
		} finally { clearInterval(sampleTimer); }
		const saveAt=performance.now();
		writeFileSync(join(works,"First/src/main.tsx"),fixture("First Edited"));
		await expect(frames[0]!.getByRole("heading",{name:"First Edited 2"})).toBeVisible();
		const saveMs=elapsed(saveAt);
		await page.getByRole("region",{name:"First",exact:true}).getByRole("button",{name:"閉じる"}).click();
		await expect(page.locator('iframe[title="First"]')).toHaveCount(0);
		const openAt=performance.now();
		await page.getByRole("list",{name:"登録済み作品"}).getByRole("listitem").filter({hasText:"First"}).getByRole("button",{name:"開く"}).click();
		await expect(frames[0]!.getByRole("heading",{name:"First Edited 2"})).toBeVisible();
		const reopen=elapsed(openAt);
		let buildSamplePeak=0;
		const monitor=setInterval(()=>{
			const pids=snapshots(host.pid);
			if (pids.length) try {buildSamplePeak=Math.max(buildSamplePeak,memory([host.pid,...pids]));} catch {}
		},35);
		try {
			writeFileSync(join(works,"First/src/main.tsx"),fixture("First Profiled"));
			await expect(frames[0]!.getByRole("heading",{name:"First Profiled 2"})).toBeVisible();
		} finally { clearInterval(monitor); }
		const hide=async()=>{
			for(const title of ["First","Second"])
				await page.getByRole("region",{name:title,exact:true}).getByRole("button",{name:"閉じる"}).click();
			await expect.poll(async()=>(await metrics()).watchers).toBe(0);
		};
		await hide();
		await expect.poll(async()=>(await metrics()).watchers).toBe(0);
		await Bun.sleep(850);
		const after=memory([host.pid]);
		watcherStates.push(await metrics());
		const childRemaining=snapshots(host.pid);
		for(const title of ["First","Second"]) assert(!existsSync(join(works,title,"node_modules")));
		both.works={sharedPreparationMs:prepareMs,firstMs:shown[0],secondMs:shown[1],updateMs:saveMs,reopenMs:reopen,
			physicalBytesByWorkCount:mem,physicalBytesFirstRegistered:registered,physicalBytesBothPagesClosed:after,
			browserBytesByWorkCount:browserWorks,browserBytesBothFramesClosed:await browserFootprint(), sampledBuildAndTypecheckPeakBytes:buildSamplePeak,
			hostPid:host.pid,loopbackPorts:[Number(new URL(origin).port),port],workerPidsObserved:[...seen],
			workerPidsAfterClose:childRemaining,watcherStates,individualNodeModules:false};
		await context.close();
		await stop(host);
		result[mode].push(both);
	}
	console.log(JSON.stringify({trials,method:"macOS process physical footprint, Chrome timings; browser memory recorded separately",results:result},null,2));
} finally {
	await browser.close();
	for(const p of starts) await stop(p);
	rmSync(path,{recursive:true,force:true});
	for(const port of ports) await assert.rejects(fetch("http://127.0.0.1:"+port));
}
