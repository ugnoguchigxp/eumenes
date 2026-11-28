import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { registerWorksImageRoutes, worksImages } from "../../../api/application/prototype/images";
import { createImage, migrations as imageMigrations } from "../../../api/domains/image";
import { createPrototypeService, imageGrantMigrations } from "../../../api/domains/prototype";
import { createQueue, migrations as queueMigrations } from "../../../api/domains/queue";
import { createLarmPlayground, findServiceTarget } from "../../../api/domains/larm";
import { openStore } from "../../../api/infrastructure/sqlite";
import { resolveLarmToken } from "../../../api/infrastructure/auth-config";
import { liveLarmSettings } from "../../../scripts/live-larm";
import { template } from "../../../api/domains/prototype/projects";
import { prepareWorksWeb } from "../instant-project-sandbox-p2-2026-11-28/web";

assert(process.argv.includes("--run"), "use --run for one live image request");
const saved = liveLarmSettings();
const token = resolveLarmToken(process.env);
assert(saved.baseUrl && token, "saved LARM connection is unavailable");
let posts = 0;
let generated: string | undefined;
const remote = createLarmPlayground({ ...saved, baseUrl: saved.baseUrl, voice: saved.voice ?? undefined, token,
	fetch: (async (url, init) => {
		const method = init?.method ?? (url instanceof Request ? url.method : "GET");
		const path = new URL(url instanceof Request ? url.url : String(url)).pathname;
		if (method === "POST" && /\/images\/generations\/?$/.test(path)) {
			posts++;
			if (posts > 1) throw new Error("live_generation_limit");
		}
		return fetch(url, init);
	}) as typeof fetch,
});
const target = findServiceTarget((await remote.catalog(AbortSignal.timeout(20_000))).targets,
	"media.image.generate", "larm.image-generation.v1");
assert(target?.description?.trim(), "catalog did not advertise a supported image service");
console.log("saved LARM catalog advertised image generation");
const library = await remote.images.list(AbortSignal.timeout(20_000));
const existing = library.images.find(item => item.bytes < 16 * 1024 * 1024);
assert(existing, "no existing LARM material is available for the trial");
const temp = realpathSync(mkdtempSync("/tmp/works-p3-live-"));
const core = resolve(import.meta.dir,"../../..");
const data = join(temp,"state"), home=join(temp,"runtime"), works=join(temp,"works"), source=join(temp,"source");
mkdirSync(data); mkdirSync(works);
const store = openStore(join(temp,"trial.db"), [...queueMigrations, ...imageMigrations, ...imageGrantMigrations]);
const queue = createQueue(store, { pollMs: 20 });
let server:ReturnType<typeof Bun.serve>|undefined;
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
let views:ReturnType<typeof createPrototypeService>|undefined;
const ports=new Set<number>();
function command(args:string[],cwd=core) {
	const result=Bun.spawnSync(args,{cwd,stdout:"pipe",stderr:"pipe",timeout:120_000});
	assert.equal(result.exitCode,0,result.stderr.toString());
	return result.stdout.toString();
}
const tool=(...args:string[])=>command([process.execPath,"--no-env-file","scripts/works-runtime.ts",...args]);
function commit(root:string) {
	const git=(...args:string[])=>command(["/usr/bin/git","-c","core.hooksPath=/dev/null",...args],root);
	git("init","-q","--template="); git("add",".");
	git("-c","user.name=Works Trial","-c","user.email=works-test@example.invalid","commit","-qm","fixture");
	return git;
}
try {
	tool("export",source); commit(source)("tag","works-v3.0");
	const pin=JSON.parse(tool("pin",source,"3.0"));
	tool("install",home,source,"3.0",pin.commit,pin.digest);
	const folder=join(works,"beta");
	template(folder,"Beta", "3.0");
	const file=join(folder,"prototype.json"), definition=JSON.parse(readFileSync(file,"utf8"));
	definition.features=["library.image.read","media.image.generate"];
	writeFileSync(file, JSON.stringify(definition));
	writeFileSync(join(folder,"src/main.tsx"), `
import { useEffect, useState } from "react";
import { mount, type Adapter } from "eumenes-prototype/app";
function Picture({bytes, label}: {bytes?:Blob;label:string}) {
 const [url, setUrl] = useState("");
 useEffect(() => {
  if (!bytes) return;
  const value=URL.createObjectURL(bytes); setUrl(value);
  return ()=>URL.revokeObjectURL(value);
 }, [bytes]);
 return url && <img alt={label} src={url} />;
}
function Gallery({adapter}: {adapter: Adapter}) {
 const [saved,setSaved]=useState<Blob>();
 const [generated,setGenerated]=useState<Blob>();
 useEffect(()=>{
  if(adapter.mode!=="eumenes") return;
  let active=true;
  const tick=async()=>{
   if(!saved) {
    const assets=await adapter.images.assets();
    if(assets[0]) {const blob=await adapter.images.read(assets[0].id);if(active) setSaved(blob);}
   }
   if(!generated) {
    const ready=(await adapter.images.generations()).find(row=>row.state==="completed");
    if(ready) {const blob=await adapter.images.content(ready.operationId);if(active) setGenerated(blob);}
   }
  };
  const timer=setInterval(()=>void tick().catch(()=>{}),1200);
  return()=>{active=false; clearInterval(timer)};
 },[adapter,saved,generated]);
 return <><h1>LARM live gallery</h1><Picture bytes={saved} label="保存済みLARM画像"/><Picture bytes={generated} label="生成したLARM画像"/></>;
}
mount(({root,adapter})=>root.render(<Gallery adapter={adapter}/>));
`);
	commit(folder);

	const preview=Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response()});
	const previewPort=preview.port!; ports.add(previewPort); await preview.stop(true);
	let web:Awaited<ReturnType<typeof prepareWorksWeb>>|undefined;
	server=Bun.serve({hostname:"127.0.0.1",port:0,idleTimeout:0,fetch:req=>web?.(req)??new Response("pending",{status:503})});
	const origin="http://127.0.0.1:"+server.port;
	ports.add(server.port!);
	views=createPrototypeService({core,data,works,runtime:home,defaultVersion:"3.0",parentOrigin:origin,previewPort});
	const project=views.register(folder).id;
	const controls=worksImages(store,views);
	const gateway=()=>({...remote,async execute(...args:Parameters<typeof remote.execute>) {
		const value=await remote.execute(...args); generated=value.artifact?.id; return value;
	}});
	const image=createImage({store,queue,gateway,prototypeGuard:controls.allows,inference:{} as never,capabilities:{} as never});
	web=await prepareWorksWeb({core,temp,origin,previewPort,works:views,mount(app){registerWorksImageRoutes(app,controls,image);}});
	const call=(path:string,input?:object)=>fetch(origin+"/api/prototypes/"+project+"/images"+path,{
		method:input?"POST":"GET",
		headers:{authorization:"Bearer fixture-token-for-toolchain-browser","content-type":"application/json"},
		...(input?{body:JSON.stringify(input)}:{})
	});
	queue.start();

	assert.equal((await call("/grant",{expectedRevision:0,enabled:true,assetIds:[existing.id]})).status,200);
	browser=await chromium.launch({channel:"chrome",args:["--mute-audio","--no-proxy-server"]});
	const page=await browser.newPage();
	await page.goto(origin+"/#works/"+project);
	const frame=page.frameLocator('iframe[title="Beta"]');
	await expect(frame.getByRole("heading",{name:"LARM live gallery"})).toBeVisible({timeout:15_000});
	const savedImage=frame.getByRole("img",{name:"保存済みLARM画像"});
	await expect.poll(()=>savedImage.evaluate((node:HTMLImageElement)=>node.naturalWidth),{timeout:20_000}).toBeGreaterThan(0);
	const prompt="A simple watercolor landscape with a small red lighthouse, no text.";
	await page.getByLabel("画像の説明").fill(prompt);
	await page.getByRole("button",{name:"画像を生成",exact:true}).click();
	await expect.poll(async()=>{
		const r=await call("/generations");
		if(!r.ok) return 0;
		return (await r.json()).length;
	}).toBe(1);
	const [{operationId}]=await (await call("/generations")).json();
	const replay=await call("/generations",{operationId,prompt,width:512,height:384,format:"png",seed:42});
	assert.equal(replay.status,202);
	assert.equal((await replay.json()).operationId,operationId);
	const requested=Date.now();
	for(;;) {
		const poll=await call("/generations/"+operationId);
		assert.equal(poll.status,200);
		const status=await poll.json();
		if(status.state!=="generating") {assert.equal(status.state,"completed",status.errorCode); break;}
		if(Date.now()-requested>275_000) throw new Error("live image acceptance deadline");
		await Bun.sleep(1600);
	}
	const result=frame.getByRole("img",{name:"生成したLARM画像"});
	await expect.poll(()=>result.evaluate((node:HTMLImageElement)=>node.naturalWidth),{timeout:20_000}).toBeGreaterThan(0);
	await expect(savedImage).toBeVisible();
	const download=await call("/generations/"+operationId+"/content");
	assert.equal(download.status,200);
	const bytes=await download.arrayBuffer();
	assert(bytes.byteLength>0 && generated);
	assert.equal(image.list("main").length,0);
	assert.equal(image.activity(0).lastSuccessAt,null);
	assert.equal(posts,1);
	console.log(JSON.stringify({savedMaterialRead:true,generatedBytes:bytes.byteLength,generationPosts:posts,excludedFromConversation:true,bothImagesRenderedInSameChromeFrame:true}));
} finally {
	await browser?.close();
	await queue.close();
	await views?.close();
	await server?.stop(true);
	await store.close();
	rmSync(temp,{recursive:true,force:true});
	if(generated && generated!==existing.id) {
		await remote.images.remove(generated,AbortSignal.timeout(20_000));
		console.log("removed the image generated by this trial");
	}
	for(const port of ports) await assert.rejects(fetch("http://127.0.0.1:"+port));
}
