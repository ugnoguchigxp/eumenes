import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { Hono } from "hono";
import { registerPrototypeRoutes } from "../../../api/application/prototype/routes";
import { createPrototypeService } from "../../../api/domains/prototype";
import { prepareWorksWeb } from "../instant-project-sandbox-p2-2026-11-28/web";

const core = realpathSync(resolve(import.meta.dir, "../../.."));
const existing = process.argv[2] && realpathSync(process.argv[2]);
assert(existing, "Pass the existing L-Lang repository root");
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "works-p4-")));
const runtime = join(tmp, "runtime"), source = join(tmp, "source"), data = join(tmp, "data"), works = join(tmp, "works");
for (const folder of [runtime, data, works]) mkdirSync(folder);
const entry = "examples/saaa-world-clock/app.ts";
function command(args: string[], cwd = core) {
	const out = Bun.spawnSync(args, { cwd, env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_OPTIONAL_LOCKS: "0" }, stdout: "pipe", stderr: "pipe" });
	assert.equal(out.exitCode, 0, out.stderr.toString());
	return out.stdout.toString().trim();
}
const git = (root:string,...args:string[]) => command(["git","-c","core.hooksPath=/dev/null",...args],root);
const runtimeTool = (...args:string[]) => command([process.execPath, "--no-env-file", "scripts/works-runtime.ts", ...args]);
function commit(root:string) {
	git(root,"init","-q");
	git(root,"add",".");
	git(root,"-c","user.email=works-test@example.invalid","-c","user.name=Works Trial","commit","-qm","fixture");
}
function state(root: string, sources:string[]) {
	const hash = (bytes:Buffer|string) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
	return {
		root: git(root,"rev-parse","--show-toplevel"),
		common: git(root,"rev-parse","--path-format=absolute","--git-common-dir"),
		head: git(root,"rev-parse","HEAD"),
		remotes: hash(git(root,"remote","-v")),
		index: hash(readFileSync(git(root,"rev-parse","--path-format=absolute","--git-path","index"))),
		status: git(root,"status","--porcelain=v1","-uall"),
		diff: hash(git(root,"diff","--binary","HEAD")),
		files: sources.map((name) => existsSync(join(root,name)) ? hash(readFileSync(join(root,name))) : null),
	};
}
let service:ReturnType<typeof createPrototypeService>|undefined;
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
let original:ReturnType<typeof Bun.serve>|undefined;
let webServer:ReturnType<typeof Bun.serve>|undefined;
const ports = new Set<number>();
try {
	runtimeTool("export",source); commit(source); git(source,"tag","works-v3.0");
	const pin = JSON.parse(runtimeTool("pin",source,"3.0"));
	runtimeTool("install",runtime,source,"3.0",pin.commit,pin.digest);
	const reservation=Bun.serve({hostname:"127.0.0.1", port:0, fetch:()=>new Response()});
	const previewPort=reservation.port!; ports.add(previewPort); await reservation.stop(true);
	let web:Awaited<ReturnType<typeof prepareWorksWeb>>|undefined;
	webServer=Bun.serve({hostname:"127.0.0.1", port:0, fetch:req=>web?.(req)??new Response("pending",{status:503})});
	const origin="http://127.0.0.1:"+webServer.port; ports.add(webServer.port!);
	service = createPrototypeService({core, data, works, runtime, defaultVersion:"3.0", previewPort, parentOrigin:origin});
	web=await prepareWorksWeb({core,temp:tmp,origin,previewPort,works:service});
	const app = new Hono();
	registerPrototypeRoutes(app, service);
	const api = async(method:string,path:string, input?:unknown) => {
		const r=await app.request("/api/prototypes"+path,{
			method, ...(input ? {headers:{"Content-Type":"application/json"},body:JSON.stringify(input)} : {}),
		});
		assert.equal(r.status,200,await r.clone().text());
		return r.json();
	};
	async function preview(id:string) {
		await api("POST","/"+id+"/open");
		for(let i=0;i<240;i++) {
			const view=await api("GET","/"+id+"/preview");
			if (view.url) return view;
			if (view.state==="failed" || view.state==="unsupported") throw new Error(JSON.stringify(view));
			await Bun.sleep(100);
		}
		throw new Error("preview timed out");
	}
	browser = await chromium.launch({channel:"chrome", args:["--mute-audio","--no-proxy-server"]});
	const page = await browser.newPage();
	const fixture = join(works,"browser-app");
	mkdirSync(join(fixture,"web"),{recursive:true});
	writeFileSync(join(fixture,"package.json"),JSON.stringify({scripts:{dev:"bun original.ts"},dependencies:{react:"^19.0.0","fixture-unavailable":"1.0.0"}}));
	writeFileSync(join(fixture,"bun.lock"),"original lock bytes\n");
	writeFileSync(join(fixture,"web/main.ts"),'document.getElementById("legacy-root")!.textContent="Existing browser project";\n');
	commit(fixture);
	git(fixture,"remote","add","origin","https://example.invalid/original.git");
	writeFileSync(join(fixture,"web/main.ts"),'document.getElementById("legacy-root")!.textContent="Existing browser project, unsaved revision";\n');
	const fixtureFiles=["package.json","bun.lock","web/main.ts"];
	const fixtureBefore=state(fixture,fixtureFiles);
	await page.goto(origin+"/#works");
	await page.getByText("既存作品を試験導入",{exact:true}).click();
	await page.getByLabel("作品のGitルート").fill(fixture);
	await page.getByLabel("表示名").fill("Compatible existing browser fixture");
	await page.getByLabel("入口ファイル").fill("web/main.ts");
	await page.getByLabel("ソースと素材（カンマ区切り）").fill("web/main.ts");
	await page.getByLabel("表示先の要素ID（任意）").fill("legacy-root");
	await page.getByRole("button",{name:"試験導入",exact:true}).click();
	await expect(page.getByText("試験導入の棚卸し",{exact:true})).toBeVisible();
	await expect(page.getByText("fixture-unavailable",{exact:true})).toBeVisible();
	await expect(page.frameLocator('iframe[title="Compatible existing browser fixture"]').getByText("Existing browser project, unsaved revision")).toBeVisible();
	await Bun.sleep(11_000);
	await expect(page.frameLocator('iframe[title="Compatible existing browser fixture"]').getByText("Existing browser project, unsaved revision")).toBeVisible();
	const [accepted]=(await api("GET","")).projects;
	const compatible=await preview(accepted.id);
	ports.add(Number(new URL(compatible.url).port));
	const report=await api("GET","/"+accepted.id+"/trial");
	assert(report.missing.includes("fixture-unavailable"));
	assert(report.versionDifferences.some((x:{name:string; shared:string})=>x.name==="react" && x.shared==="19.2.7"));
	assert.throws(()=>service!.editTarget(accepted.id),/prototype_trial_read_only/);
	await page.getByRole("button",{name:"登録解除",exact:true}).click();
	await page.getByRole("button",{name:"解除を確定",exact:true}).click();
	await expect(page.getByText("試験導入の棚卸し",{exact:true})).toHaveCount(0);
	assert.equal((await fetch(compatible.url)).status,404);
	assert.deepEqual(state(fixture,fixtureFiles),fixtureBefore);
	assert(!existsSync(join(fixture,".eumenes")) && !existsSync(join(fixture,"prototype.json")) && !existsSync(join(fixture,"node_modules")));

	const files=["package.json","bun.lock",entry,"examples/saaa-world-clock/index.html","examples/saaa-world-clock/server.ts"];
	const before=state(existing,files);
	const trial=await api("POST","/trial",{path:existing,name:"L-Lang World Clock",environment:"3.0",entry,include:[entry]});
	const inventory=await api("GET","/"+trial.id+"/trial");
	assert(inventory.originalCommands.includes("world-clock:demo"));
	assert.deepEqual(inventory.unsupported,["index.html","server.ts"]);
	const tested=await preview(trial.id);
	ports.add(Number(new URL(tested.url).port));
	const bootError=page.waitForEvent("pageerror");
	await page.goto(tested.url);
	assert.match((await bootError).message,/runtime-status/);
	await api("DELETE","/"+trial.id);
	assert.equal((await fetch(tested.url)).status,404);
	assert.deepEqual(service.metrics(),{watchers:0,waiting:0,active:0});
	assert.equal((await api("GET","")).projects.length,0);
	assert.deepEqual(state(existing,files),before);

	// Keep the original demo's handler and assets. Supply the loopback-only binding here.
	const { createWorldClockDemo } = await import(join(existing,"examples/saaa-world-clock/server.ts"));
	const demo=await createWorldClockDemo();
	original=Bun.serve({port:0,hostname:"127.0.0.1",fetch:demo.fetch});
	ports.add(original.port!);
	await page.goto(original.url.toString());
	await expect(page.locator("#runtime-status")).toHaveAttribute("data-state","ready");
	assert((await page.locator(".clock-card").count())>0);
	assert.deepEqual(state(existing,files),before);
	console.log(JSON.stringify({cleanGitAndFiles:true,gitRootCommonAndRemotesUnchanged:true,existingProject:"L-Lang World Clock",
		existingCompatibility:"requires generated HTML, capability JSON and WebAssembly served by the original server",
		originalHandlerReady:true,buildAndPreviewOnCompatibleFixture:true,registeredAndRemovedInChrome:true,legacyPreviewStayedOpen:true,readOnlyEditRejected:true,registrationOutputWatchersRemoved:true,
		missingDependencyExamples:inventory.missing,configuration:inventory.configuration,unsupported:inventory.unsupported}));
} finally {
	await browser?.close();
	await original?.stop(true);
	await service?.close();
	await webServer?.stop(true);
	rmSync(tmp,{recursive:true,force:true});
	for(const port of ports) await assert.rejects(fetch("http://127.0.0.1:"+port));
}
