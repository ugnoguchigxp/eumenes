import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createImage, migrations as imageMigrations, registerImage } from "../../../api/domains/image";
import { createPrototypeService, imageGrantMigrations } from "../../../api/domains/prototype";
import { template } from "../../../api/domains/prototype/projects";
import { createQueue, migrations as queueMigrations } from "../../../api/domains/queue";
import { openStore } from "../../../api/infrastructure/sqlite";
import { workspaceGit as git } from "../../../api/domains/coding";
import type { LarmPlayground } from "../../../api/domains/larm";
import { generateImageRequest } from "../../../api/domains/larm/service/image-generation";
import { registerWorksImageRoutes, worksImages } from "../../../api/application/prototype/images";
import { prepareWorksWeb } from "../instant-project-sandbox-p2-2026-11-28/web";

const core = resolve(import.meta.dir, "../../..");
const tmp = realpathSync(mkdtempSync("/tmp/works-p3-web-"));
const home = join(tmp,"runtime"), root = join(tmp,"works"), data = join(tmp,"state"), source = join(tmp,"release");
mkdirSync(root); mkdirSync(data);
const ports = new Set<number>();
const store = openStore(join(tmp,"trial.db"), [...queueMigrations, ...imageMigrations, ...imageGrantMigrations]);
const queue = createQueue(store, {pollMs:15});
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+l9koAAAAASUVORK5CYII=", "base64");
const artifact = (id:string) => ({
	id, width:1,height:1,format:"png",mimeType:"image/png",createdAt:"2026-11-28T00:00:00.000Z",
	hasAlpha:false,bytes:png.length,sha256:new Bun.CryptoHasher("sha256").update(png).digest("hex"),contentUrl:"/fixture/" + id,
});
let posts = 0;
const stopped: Array<ReturnType<typeof Promise.withResolvers<void>>> = [];
const generated: string[] = [];
const gateway = {
	mediaBinding:"fixture",
	async catalog() { return { targets: [{mode:"service",kind:"image",capability:"media.image.generate",protocol:"larm.image-generation.v1",description:"Test generator"}] }; },
	images: {
		async list() { return {images:[artifact("saved-image")],maxBytes:1000,targetBytes:900,totalBytes:png.length}; },
		async get(id:string) { if(id!=="saved-image"&&!generated.includes(id)) throw new Error("larm_http_404"); return artifact(id); },
	},
	async artifact() { return {bytes:png,mime:"image/png"}; },
	async execute(_target:unknown, input:{text:string}, signal:AbortSignal) {
		const id = "generated-" + ++posts;
		if (input.text === "Response lost") return generateImageRequest(async () => { throw new Error("network_unavailable"); }, "/fixture/generation", input, signal);
		const hold = Promise.withResolvers<void>();
		stopped.push(hold);
		await hold.promise; // Fixture deliberately delivers a late provider result after cancellation.
		generated.push(id);
		return { artifact:{id},bytes:png,mime:"image/png" };
	},
} as unknown as LarmPlayground;
function tool(...args:string[]) {
	const r = Bun.spawnSync([process.execPath,"--no-env-file","scripts/works-runtime.ts",...args],
		{cwd:core,stdout:"pipe",stderr:"pipe",timeout:120_000});
	if (r.exitCode) throw new Error(r.stderr.toString());
	return r.stdout.toString();
}
function commit(path:string) {
	git(path,["init","--initial-branch=main","--template="]);
	git(path,["add","."]);
	git(path,["-c","user.name=Works trial","-c","user.email=works@example.invalid","commit","-m","P3 trial"]);
}
async function until<T>(condition:()=>T|undefined|Promise<T|undefined>, timeout=15_000) {
	const end=Date.now()+timeout;
	while(Date.now()<end) {
		const value=await condition();
		if(value!==undefined) return value;
		await Bun.sleep(100);
	}
	throw new Error("trial condition timed out");
}
let server:ReturnType<typeof Bun.serve>|undefined, views:ReturnType<typeof createPrototypeService>|undefined;
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
let standalone:ReturnType<typeof Bun.spawn>|undefined;
let checkpoint="prepare";
try {
	tool("export",source); commit(source); git(source,["tag","works-v3.0"]);
	const pin=JSON.parse(tool("pin",source,"3.0"));
	tool("install",home,source,"3.0",pin.commit,pin.digest);
	const a=join(root,"alpha"), b=join(root,"beta");
	for(const [folder,name] of [[a,"Alpha"],[b,"Beta"]] as const) {
		template(folder,name,"3.0");
		const definition=JSON.parse(readFileSync(join(folder,"prototype.json"),"utf8"));
		definition.features=["library.image.read","media.image.generate"];
		definition.include.push("samples");
		writeFileSync(join(folder,"prototype.json"),JSON.stringify(definition));
		mkdirSync(join(folder,"samples")); writeFileSync(join(folder,"samples","example.png"),png);
		writeFileSync(join(folder,"src/main.tsx"), `
import { mount } from "eumenes-prototype/app";
import { useEffect, useState } from "react";
mount(({adapter,root}) => {
 function Main() {
  const [saved, setSaved] = useState<Blob>();
  const [image,setImage] = useState<Blob>();
  const [features,setFeatures] = useState<string[]>([]);
  const [heading,setHeading] = useState("Photo Works");
  useEffect(() => {
   const timer = setInterval(() => {
    if (adapter.mode === "sample") return;
    void adapter.images.assets().then(items => items[0] ? adapter.images.read(items[0].id).then(setSaved) : setSaved(undefined)).catch(() => setSaved(undefined));
    void adapter.images.generations().then(items => {
     const chosen = items.find(item => item.state === "completed");
     if (chosen) void adapter.images.content(chosen.operationId).then(setImage).catch(() => setImage(undefined));
     else setImage(undefined);
    }).catch(() => setImage(undefined));
   }, 350);
   return () => clearInterval(timer);
  },[]);
  function Picture({blob,alt}:{blob:Blob;alt:string}) {
   const [url,setUrl]=useState("");
   useEffect(() => { const value=URL.createObjectURL(blob);setUrl(value);return () => URL.revokeObjectURL(value); },[blob]);
   return <img src={url || undefined} alt={alt}/>;
  }
  return <><h1>{heading}</h1><button onClick={()=>void adapter.features().then(setFeatures)}>機能を表示</button><output>{features.join(",")}</output>
   {adapter.mode === "eumenes" && <button onClick={()=>void adapter.suggestImage("An image")}>画像案を送る</button>}
   {adapter.mode === "sample" && <><p>サンプルモード</p><button onClick={() => void adapter.images.sample("samples/example.png").then(setImage)}>サンプルを取得</button></>}
   {saved && <Picture blob={saved} alt="許可済み画像"/>}{image && <Picture blob={image} alt="生成された画像"/>}</>;
 }
 root.render(<Main/>);
});`);
		commit(folder);
	}
	let web:Awaited<ReturnType<typeof prepareWorksWeb>>;
	server=Bun.serve({hostname:"127.0.0.1",port:0,idleTimeout:0,fetch(req){return web(req)??new Response(null,{status:404});}});
	const origin="http://localhost:"+server.port;ports.add(server.port!);
	const reserve=Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response()});const pp=reserve.port!;ports.add(pp);await reserve.stop(true);
	views=createPrototypeService({core,data,works:root,runtime:home,parentOrigin:origin,previewPort:pp,defaultVersion:"3.0"});
	const alpha=views.register(a), beta=views.register(b);
	const controls=worksImages(store,views);
	const image=createImage({store,queue,gateway:()=>gateway,prototypeGuard:controls.allows,inference:{} as never,capabilities:{} as never});
	web=await prepareWorksWeb({core,temp:tmp,origin,previewPort:pp,works:views,mount(app){
		registerWorksImageRoutes(app,controls,image); registerImage(app,image);
	}});
	queue.start();
	function api(project:string,path:string,method="GET",body?:object) {
		return fetch(origin+"/api/prototypes/"+project+"/images"+path,{method,headers:{authorization:"Bearer fixture-token-for-toolchain-browser","content-type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});
	}
	const grant = (id:string, expectedRevision:number, enabled:boolean, assetIds:string[]=[]) =>
		api(id,"/grant","POST",{expectedRevision,enabled,assetIds});
	assert.equal((await grant(alpha.id,0,true)).status,200);
	assert.equal((await grant(beta.id,0,true,["saved-image"])).status,200);
	assert.equal((await api(alpha.id,"/assets/saved-image")).status,403);
	browser=await chromium.launch({channel:"chrome",args:["--mute-audio","--no-proxy-server"]});
	const page=await browser.newPage();
	checkpoint="asset delivery";
	await page.goto(origin+"/#works/"+beta.id);
	const frame=page.frameLocator('iframe[title="Beta"]');
	await expect(frame.getByRole("heading",{name:"Photo Works"})).toBeVisible({timeout:15000});
	await expect(frame.getByRole("img",{name:"許可済み画像"})).toBeVisible({timeout:15000});
	const original = await page.locator('iframe[title="Beta"]').getAttribute("src");
	checkpoint="generation and rebuild";
	await frame.getByRole("button",{name:"機能を表示"}).click();
	await expect(frame.getByText("library.image.read,media.image.generate",{exact:true})).toBeVisible();
	await frame.getByRole("button",{name:"画像案を送る"}).click();
	await expect(page.getByText("作品からの画像案 An image",{exact:true})).toBeVisible();
	assert.equal(posts,0);
	await page.getByRole("button",{name:"画像案を使う"}).click();
	await expect(page.getByLabel("画像の説明")).toHaveValue("An image");
	assert.equal(posts,0);
	await page.getByRole("button",{name:"画像を生成",exact:true}).click();
	await until(()=>posts===1?true:undefined);
	const listed=await (await api(beta.id,"/generations")).json();
	const id=listed[0].operationId;
	const body={operationId:id,prompt:"An image",width:512,height:384,format:"png",seed:42};
	assert.equal((await api(beta.id,"/generations","POST",body)).status,202);
	const startedMetadata = () => store.read(db => db.query("SELECT bindings_json, hard_deadline FROM image_generations WHERE prototype_id=? AND operation_id=?").get(beta.id,id)) as {bindings_json:string;hard_deadline:number};
	const originalMetadata = startedMetadata();
	assert.match(JSON.parse(originalMetadata.bindings_json).inputVersion,/^[a-f0-9]{64}$/);
	assert.equal((await api(beta.id,"/generations","POST",{...body,prompt:"changed"})).status,409);
	const p="/generations/"+id;
	for(const [suffix,method] of [["","GET"],["","DELETE"],["/content","GET"]])
		assert.equal((await api(alpha.id,p+suffix,method)).status,404);
	const file=join(b,"src/main.tsx");
	writeFileSync(file,readFileSync(file,"utf8").replace('"Photo Works"','"Photo Works updated"'));
	await expect(frame.getByRole("heading",{name:"Photo Works updated"})).toBeVisible({timeout:15000});
	assert.notEqual(await page.locator('iframe[title="Beta"]').getAttribute("src"),original);
	assert.equal(posts,1);
	stopped[0]!.resolve();
	await expect(frame.getByRole("img",{name:"生成された画像"})).toBeVisible({timeout:15000});
	assert.equal(posts,1);
	assert.equal((await api(beta.id,p+"/content")).status,200);
	assert.equal((await api(beta.id,"/generations","POST",body)).status,202);
	assert.deepEqual(startedMetadata(),originalMetadata);
	assert.equal(image.list("main").length,0);assert.equal(image.activity(0).lastSuccessAt,null);
	checkpoint="cancel and revoke";
	const late=crypto.randomUUID();
	assert.equal((await api(beta.id,"/generations","POST",{...body,operationId:late})).status,202);
	await until(()=>posts===2?true:undefined);
	assert.equal((await api(beta.id,"/generations/"+late,"DELETE")).status,200);
	stopped[1]!.resolve();
	assert.equal((await api(beta.id,"/generations/"+late+"/content")).status,404);
	const revoked=crypto.randomUUID();
	assert.equal((await api(beta.id,"/generations","POST",{...body,operationId:revoked})).status,202);
	await until(()=>posts===3?true:undefined);
	assert.equal((await grant(beta.id,1,false,[])).status,200);
	stopped[2]!.resolve();
	assert.equal((await api(beta.id,"/generations/"+revoked+"/content")).status,403);
	await expect(frame.getByRole("img",{name:"生成された画像"})).toHaveCount(0,{timeout:12000});
	await expect(frame.getByRole("img",{name:"許可済み画像"})).toHaveCount(0,{timeout:12000});
	checkpoint="lost provider response";
	assert.equal((await grant(beta.id,2,true)).status,200);
	const lost=crypto.randomUUID();
	const lostRequest={...body,operationId:lost,prompt:"Response lost"};
	assert.equal((await api(beta.id,"/generations","POST",lostRequest)).status,202);
	await until(async()=>{
		const status=await (await api(beta.id,"/generations/"+lost)).json();
		return status.state==="failed" && status.errorCode==="generation_unknown" ? true : undefined;
	});
	assert.equal((await api(beta.id,"/generations","POST",lostRequest)).status,202);
	assert.equal(posts,4);
	checkpoint="standalone sample";
	const probe=Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response()});const samplePort=probe.port!;ports.add(samplePort);await probe.stop(true);
	standalone=Bun.spawn([join(home,"bin","eumenes-prototype"),"dev","--port="+samplePort],{
		cwd:b, env:{PATH:process.env.PATH,EUMENES_PROTOTYPE_HOME:home},stdout:"pipe",stderr:"inherit",
	});
	const address=await firstLine(standalone.stdout as ReadableStream<Uint8Array>);
	assert.equal(new URL(address).port,String(samplePort));
	const sample=await browser.newPage();
	const backendRequests:string[]=[];
	sample.on("request",r=>{if(new URL(r.url()).origin===origin)backendRequests.push(r.url());});
	await sample.goto(address);
	await expect(sample.getByText("サンプルモード")).toBeVisible();
	await sample.getByRole("button",{name:"機能を表示"}).click();
	await expect(sample.getByText("library.image.read",{exact:true})).toBeVisible();
	await sample.getByRole("button",{name:"サンプルを取得"}).click();
	await expect(sample.getByRole("img",{name:"生成された画像"})).toBeVisible();
	assert.deepEqual(backendRequests,[]);
	console.log(JSON.stringify({ protectedAssets:true, browserBridge:true, providerPostsDuringRebuild:1, sameOperationAfterRebuild:true,
		crossProjectStatusCancelContentDenied:true, cancellationIgnoredLateResult:true, revokedContentUnavailable:true,
		conversationGenerations:0, planningInference:0, standaloneSample:true, standaloneCoreRequests:backendRequests.length,
		startMetadataRetained:true, lostResponseUnknownWithoutAnotherPost:true, suggestionRequiresHostAction:true, adapterCapabilitiesScoped:true }));
} catch(e) {console.error("P3 checkpoint",checkpoint);throw e;}
finally {
	for (const pending of stopped) pending.resolve();
	await browser?.close();
	if (standalone?.exitCode===null) standalone.kill("SIGTERM");
	await standalone?.exited;
	await queue.close();
	await views?.close();
	await server?.stop(true);
	await store.close();
	rmSync(tmp,{recursive:true,force:true});
	for(const port of ports) await assert.rejects(fetch("http://127.0.0.1:"+port));
}

async function firstLine(stream:ReadableStream<Uint8Array>) {
	const reader=stream.getReader();
	const decoder=new TextDecoder();
	try {
		let buffer="";
		while(!buffer.includes("\n")) {
			const chunk=await reader.read();
			assert.equal(chunk.done,false,"standalone command did not report a preview URL");
			buffer+=decoder.decode(chunk.value,{stream:true});
		}
		return buffer.split("\n")[0]!.trim();
	} finally { reader.releaseLock(); }
}
