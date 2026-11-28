import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { build as viteBuild } from "vite";
import react from "@vitejs/plugin-react";
import { worksFrameSource } from "../../../api/infrastructure/works-preview";
import { createApp } from "../../../api/application/app";
import { prototypeModule } from "../../../api/application/prototype/wiring";
import { template } from "../../../api/domains/prototype/projects";
import { git } from "../../../packages/coding-runner/src/workspace";
import { fixtureSources, gallery, gravity } from "./fixtures";

const core = resolve(import.meta.dir, "../../..");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "eumenes-works-p1-test-")));
const [works, repo, runtime, clones, settings, gitHome] = ["works", "release-source", "runtime", "clones", "state", "git-home"].map((dir) => join(scratch, dir));
for (const dir of [works, clones, settings, gitHome]) mkdirSync(dir);
writeFileSync(join(gitHome, ".gitconfig"), "[user]\nname = Works P1 test\nemail = works-p1@example.invalid\n");
const originalHome = process.env.HOME;
const processes = new Set<ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>>();
const ports = new Set<number>();
const token = "works-p1-fixture-token";
function previewFetch(url: URL | string) {
	const target = new URL(url);
	return fetch("http://127.0.0.1:" + target.port + target.pathname, { headers: { Host: target.host } });
}

function command(args: string[], cwd = core, env = process.env) {
	const result = Bun.spawnSync(args, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 120_000 });
	if (result.exitCode !== 0) throw new Error(args.at(1) + " failed: " + result.stderr.toString());
	return result.stdout.toString();
}
const repoGit = (dir: string, ...args: string[]) => git(dir, ["-c", "user.name=Fixture", "-c", "user.email=works@example.invalid", ...args]);
const tool = (args: string[]) => command([process.execPath, "--no-env-file", "scripts/works-runtime.ts", ...args]);
function absent(root: string) {
	for (const name of ["node_modules", "bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"])
		assert.equal(existsSync(join(root, name)), false, root + "/" + name);
}
const globalStatus = repoGit(core, "status", "--short", "--untracked-files=all");
let app: ReturnType<typeof createApp> | undefined;
const web = new Map<string, Response>();
const server = Bun.serve({
	hostname: "127.0.0.1", port: 0,
	fetch(req) {
		const path = new URL(req.url).pathname;
		if (path.startsWith("/api/")) return app!.fetch(req);
		const body = web.get(path);
		if (body) return body.clone();
		return new Response(null, { status: 404 });
	},
});
const origin = "http://localhost:" + server.port;
ports.add(server.port!);
let module: ReturnType<typeof prototypeModule>;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let standaloneCalls = 0;
async function api(path: string, method = "GET", payload?: object) {
	const response = await fetch(origin + "/api/prototypes" + path, {
		method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
		...(payload ? { body: JSON.stringify(payload) } : {}),
	});
	const body = await response.json();
	assert.equal(response.ok, true, JSON.stringify(body));
	return body;
}

try {
	tool(["export", repo]);
	repoGit(repo, "init", "--initial-branch=main", "--template=");
	repoGit(repo, "add", ".");
	repoGit(repo, "commit", "-m", "Works release");
	repoGit(repo, "tag", "works-v1.0");
	const pin = JSON.parse(tool(["pin", repo, "1.0"]));
	command([process.execPath, "--no-env-file", join(repo, "prepare.ts"), "install",
		runtime, repo, "1.0", pin.commit, pin.digest], scratch);
	assert(existsSync(join(runtime, "releases/1.0/node_modules")));
	console.log("shared release installed", pin.digest);

	// Reserve and relinquish an ephemeral loopback port for the configured preview listener.
	const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
	const previewPort = probe.port!;
	await probe.stop(true);
	ports.add(previewPort);
	process.env.HOME = gitHome;
	module = prototypeModule({
		origin, dbPath: join(settings, "unused.sqlite3"),
		env: { EUMENES_WORKS_DIR: works, EUMENES_PROTOTYPE_HOME: runtime, EUMENES_PROTOTYPE_PREVIEW_PORT: String(previewPort) },
	});
	assert(module);
	app = createApp({ origin, token, modules: [module.module, { mount(hono) {
		hono.get("/api/status", (c) => c.json({ service: "eumenes", phase: "ready" }));
	} }] });
	const denied = await fetch(origin + "/api/prototypes");
	assert.equal(denied.status, 401);
	const builtWeb = join(scratch, "web-build");
	await viteBuild({
		configFile: false, root: join(core, "web"), envDir: scratch, publicDir: false,
		cacheDir: join(scratch, "vite-cache"), logLevel: "error", plugins: [react()],
		resolve: { dedupe: ["zod"] },
		build: { outDir: builtWeb, rollupOptions: {
			input: join(import.meta.dir, "web-entry.tsx"),
			output: { entryFileNames: "fixture.js", assetFileNames: "assets/[name]-[hash][extname]" },
		} },
	});
	const mime: Record<string, string> = { js: "text/javascript", css: "text/css" };
	for (const path of readdirSync(builtWeb, { recursive: true, withFileTypes: true })) {
		if (!path.isFile()) continue;
		const file = join(path.parentPath, path.name);
		web.set(file.slice(builtWeb.length), new Response(Bun.file(file), {
			headers: { "Content-Type": mime[path.name.split(".").at(-1)!] ?? "application/octet-stream" },
		}));
	}
	const links = [...web.keys()].filter((name) => name.endsWith(".css")).map((name) => '<link rel="stylesheet" href="' + name + '">').join("");
	web.set("/", new Response('<!doctype html><meta charset="utf-8">' + links + '<div id="root"></div><script type="module" src="/fixture.js"></script>',
		{ headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy":
			"default-src 'self'; style-src 'self' 'unsafe-inline'; frame-src 'self' " + worksFrameSource(previewPort) } }));

	browser = await chromium.launch({ channel: "chrome", args: ["--mute-audio", "--no-proxy-server", "--use-angle=swiftshader"] });
	const page = await browser.newPage();
	page.on("pageerror", (error) => console.log("browser page error", error.message));
	await page.goto(origin + "/#works");
	await expect(page.getByRole("heading", { name: "Works" })).toBeVisible();

	await page.getByLabel("新規作品のフォルダ名").fill("gravity");
	await page.getByRole("button", { name: "作成", exact: true }).click();
	const gravityRow = page.getByRole("listitem").filter({ hasText: "gravity" });
	await expect(gravityRow).toBeVisible();
	const a = join(works, "gravity");
	fixtureSources(a, gravity);
	repoGit(a, "add", ".");
	repoGit(a, "commit", "-m", "3D gravity and texture");
	const b = join(works, "image-board");
	template(b, "Image board", "1.0");
	fixtureSources(b, gallery);
	repoGit(b, "init", "--initial-branch=main", "--template=");
	repoGit(b, "add", ".");
	repoGit(b, "commit", "-m", "Existing image board");
	repoGit(b, "remote", "add", "origin", "https://example.invalid/image-board.git");
	await page.getByLabel("既存作品のフォルダ").fill(b);
	await page.getByRole("button", { name: "登録", exact: true }).click();
	const galleryRow = page.getByRole("listitem").filter({ hasText: "Image board" });
	await expect(galleryRow).toBeVisible();
	const projects = (await api("")).projects as { id: string; name: string }[];
	const aid = projects.find(({ name }) => name === "gravity")!.id;
	const bid = projects.find(({ name }) => name === "Image board")!.id;

	for (const root of [a, b]) {
		assert.equal(repoGit(root, "rev-parse", "--show-toplevel").trim(), root);
		assert.match(repoGit(root, "rev-parse", "--absolute-git-dir"), /\.git/);
		absent(root);
	}
	assert.notEqual(repoGit(a, "rev-parse", "HEAD"), repoGit(b, "rev-parse", "HEAD"));
	const overlap = await fetch(origin + "/api/prototypes/register", {
		method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify({ path: core }),
	});
	assert.equal(overlap.status, 400);
	await Promise.all([api("/" + aid + "/open", "POST"), api("/" + bid + "/open", "POST")]);
	const [queuedA, queuedB] = await Promise.all([api("/" + aid + "/preview"), api("/" + bid + "/preview")]);
	assert([queuedA.state, queuedB.state].includes("waiting"));
	assert.equal(module.service.metrics().watchers, 2);
	assert.equal(module.service.metrics().active, 1);
	await gravityRow.getByRole("button", { name: "開く", exact: true }).click();
	await galleryRow.getByRole("button", { name: "開く", exact: true }).click();
	const frameA = page.frameLocator('iframe[title="gravity"]');
	const frameB = page.frameLocator('iframe[title="Image board"]');
	await expect(frameA.getByRole("heading", { name: "Gravity 1" })).toBeVisible({ timeout: 25_000 });
	await expect(frameB.getByRole("heading", { name: "Image board 1" })).toBeVisible({ timeout: 25_000 });
	await expect(frameA.getByText("GLTF + texture ready")).toBeVisible();
	await expect(frameA.locator("canvas")).toHaveAttribute("data-rendered", "yes");
	await expect(frameB.locator("h1")).toHaveCSS("color", "rgb(23, 119, 96)");
	await expect.poll(() => frameB.locator("img").evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(1);
	const saveSetting = frameA.getByRole("button", { name: "Save setting" });
	await saveSetting.press("Enter");
	await expect(frameA.locator("#setting"), "first frame saved locally").toHaveText("block setting");
	await expect(frameB.locator("#setting")).toHaveText("empty");
	const urlA = (await api("/" + aid + "/preview")).url as string;
	const urlB = (await api("/" + bid + "/preview")).url as string;
	assert.notEqual(new URL(urlA).origin, new URL(urlB).origin);
	assert.equal(new URL(urlA).port, new URL(urlB).port);
	assert.equal((await previewFetch(new URL("assets/texture.png", urlA))).status, 200);
	assert.equal((await previewFetch(new URL(".env", urlA))).status, 404);
	const iframeA = page.frames().find((child) => child.url() === urlA)!;
	assert(await iframeA.evaluate(() => {
		try { void parent.document.body; return false; } catch { return true; }
	}));
	assert(await iframeA.evaluate(async (parentOrigin) => {
		try { await fetch(parentOrigin + "/api/prototypes"); return false; } catch { return true; }
	}, origin));
	const iframeB = page.frames().find((child) => child.url() === urlB)!;
	await iframeA.evaluate(() => new Promise<void>((resolve, reject) => {
		const db = indexedDB.open("works-p1-acceptance-only", 1);
		db.onupgradeneeded = () => db.result.createObjectStore("settings");
		db.onerror = () => reject(db.error);
		db.onsuccess = () => { db.result.close(); resolve(); };
	}));
	assert.equal(await iframeB.evaluate(async () => (await indexedDB.databases()).some((row) => row.name === "works-p1-acceptance-only")), false);
	await iframeB.evaluate(() => {
		const channel = new BroadcastChannel("works-p1-acceptance");
		channel.onmessage = (event) => { document.body.dataset.broadcast = event.data; };
	});
	await iframeA.evaluate(() => new BroadcastChannel("works-p1-acceptance").postMessage("A"));
	await iframeB.evaluate(() => new BroadcastChannel("works-p1-acceptance").postMessage("B"));
	await expect(frameB.locator("body")).toHaveAttribute("data-broadcast", "B");
	assert.match((await previewFetch(urlA)).headers.get("content-security-policy") ?? "", /worker-src 'none'/);
	assert.equal(await iframeA.evaluate(async () => {
		try { await navigator.serviceWorker.register(new URL("app.js", location.href)); return false; }
		catch { return true; }
	}), true);
	console.log("host opened two Git roots with isolated origins and one preview listener");

	const entry = join(a, "src/main.tsx");
	writeFileSync(entry, gravity.replace("Gravity 1", "Gravity 2") + '\nconst broken: number = "typed fixture";\n');
	await expect(frameA.getByRole("heading", { name: "Gravity 2" })).toBeVisible({ timeout: 25_000 });
	await expect(page.getByText(/TS2322/)).toBeVisible();
	await expect(frameA.locator("#setting")).toHaveText("block setting");
	assert.equal((await api("/" + bid + "/preview")).url, urlB);
	writeFileSync(entry, 'import "./missing-file";' + gravity);
	await expect(page.getByLabel("gravityの状態")).toHaveText("失敗", { timeout: 25_000 });
	await expect(frameA.getByRole("heading", { name: "Gravity 2" })).toBeVisible();
	writeFileSync(entry, gravity);
	await expect(frameA.getByRole("heading", { name: "Gravity 1" })).toBeVisible({ timeout: 25_000 });
	writeFileSync(join(a, "assets/.env"), "fixture must stay private");
	symlinkSync(join(b, "assets/texture.png"), join(a, "assets/outside.png"));
	await expect(page.getByText("prototype_link_forbidden")).toBeVisible({ timeout: 15_000 });
	unlinkSync(join(a, "assets/outside.png"));
	await expect(page.getByLabel("gravityの状態")).toHaveText("表示中", { timeout: 25_000 });
	const large = join(a, "assets/large.bin");
	writeFileSync(large, "");
	truncateSync(large, 16 * 1024 * 1024 + 1);
	await expect(page.getByText("prototype_snapshot_limit")).toBeVisible({ timeout: 15_000 });
	unlinkSync(large);
	await expect(page.getByLabel("gravityの状態")).toHaveText("表示中", { timeout: 25_000 });
	const manifest = join(a, "prototype.json");
	const manifestBody = readFileSync(manifest, "utf8");
	writeFileSync(manifest, manifestBody.replace('"1.0"', '"1.9"'));
	await expect(page.getByLabel("gravityの状態")).toHaveText("環境の不足", { timeout: 15_000 });
	writeFileSync(manifest, manifestBody);
	await expect(page.getByLabel("gravityの状態")).toHaveText("表示中", { timeout: 25_000 });
	const prep = page.getByRole("region", { name: "gravity", exact: true });
	const activeA = (await api("/" + aid + "/preview")).url;
	const started = page.waitForEvent("console", { predicate: (message) => message.text() === "works-p1-busy-started" });
	const busy = page.frames().find((child) => child.url() === activeA)!.evaluate(() => {
		console.log("works-p1-busy-started");
		const until = performance.now() + 5_000;
		while (performance.now() < until) {}
	}).then(() => "finished", () => "detached");
	await started;
	const recovered = await Promise.race([
		prep.getByRole("button", { name: "停止", exact: true }).click({ timeout: 2_000 }).then(() => "stopped"),
		busy,
	]);
	assert.notEqual(recovered, "finished");
	await expect(page.getByLabel("gravityの状態")).toHaveText("応答不能");
	await expect(frameB.getByRole("heading", { name: "Image board 1" })).toBeVisible();
	await prep.getByRole("button", { name: "再試行", exact: true }).click();
	await expect(frameA.getByRole("heading", { name: "Gravity 1" })).toBeVisible({ timeout: 25_000 });

	const moved = join(works, "gravity-moved");
	renameSync(a, moved);
	await expect(page.getByLabel("gravityの状態")).toHaveText("登録先の異常", { timeout: 20_000 });
	await gravityRow.getByRole("button", { name: "移設", exact: true }).click();
	await page.getByLabel("移設先のフォルダ").fill(moved);
	await page.getByRole("button", { name: "結び直す", exact: true }).click();
	await expect(gravityRow).toContainText("gravity-moved");
	await gravityRow.getByRole("button", { name: "開く", exact: true }).click();
	await expect(frameA.locator("#setting")).toHaveText("block setting", { timeout: 25_000 });
	const afterMove = (await api("")).projects.find((item: { id: string }) => item.id === aid);
	assert.equal(afterMove.generation, 2);
	assert.equal((await previewFetch(urlA)).status, 404);
	const gitState = repoGit(b, "status", "--porcelain=v1");
	await galleryRow.getByRole("button", { name: "登録解除" }).click();
	await galleryRow.getByRole("button", { name: "解除を確定" }).click();
	await expect(galleryRow).toHaveCount(0);
	assert.equal(repoGit(b, "status", "--porcelain=v1"), gitState);
	assert.equal(repoGit(b, "remote", "get-url", "origin").trim(), "https://example.invalid/image-board.git");
	assert.equal((await previewFetch(urlB)).status, 404);
	await prep.getByRole("button", { name: "閉じる" }).click();
	await expect.poll(async () => (await api("/" + aid + "/preview")).state).toBe("hidden");
	assert.equal(module.service.metrics().watchers, 0);
	assert.equal(module.service.metrics().active, 0);
	absent(moved);
	absent(b);

	// Keep the standalone system independent by stopping the Eumenes fixture before the clone checks.
	await module.lifecycle.close?.();
	await server.stop(true);
	const env = { ...process.env, PATH: join(runtime, "bin") + ":" + process.env.PATH,
		EUMENES_PROTOTYPE_HOME: runtime };
	for (const [work, title, texture] of [[moved, "Gravity 1", "Block texture"], [b, "Image board 1", "Example from gallery"]] as const) {
		const outside = join(clones, title.split(" ")[0]!.toLowerCase());
		repoGit(clones, "clone", "--no-local", work, outside);
		absent(outside);
		const launcher = join(runtime, "bin/eumenes-prototype");
		command([launcher, "typecheck"], outside, env);
		command([process.execPath, "--no-env-file", "run", "build"], outside, env);
		assert(existsSync(join(outside, "dist/index.html")));
		const badSource = join(outside, "src/main.tsx");
		const original = readFileSync(badSource, "utf8");
		writeFileSync(badSource, original + '\nconst invalidBuild: number = "fixture";\n');
		const typeError = Bun.spawnSync([launcher, "build"], { cwd: outside, env, stderr: "pipe", stdout: "ignore" });
		assert.equal(typeError.exitCode, 1);
		assert.match(typeError.stderr.toString(), /TS2322/);
		writeFileSync(badSource, original);
		const invalid = Bun.spawnSync([launcher, "typecheck"], {
			cwd: outside, env: { ...env, EUMENES_PROTOTYPE_HOME: "" }, stderr: "pipe", stdout: "ignore",
		});
		assert.equal(invalid.exitCode, 1);
		assert.match(invalid.stderr.toString(), /EUMENES_PROTOTYPE_HOME/);
		const app = Bun.spawn([launcher, "dev", "--port=0"], { cwd: outside, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		processes.add(app);
		const reader = app.stdout.getReader();
		const first = await reader.read();
		const url = new TextDecoder().decode(first.value).trim();
		ports.add(Number(new URL(url).port));
		const standalone = await browser.newPage();
		standalone.on("request", (request) => { if (new URL(request.url()).origin === origin) standaloneCalls++; });
		await standalone.goto(url);
		await expect(standalone.getByRole("heading", { name: title })).toBeVisible();
		await expect(standalone.getByText("sample", { exact: true })).toBeVisible();
		await expect.poll(() => standalone.getByRole("img", { name: texture }).evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(1);
		if (title.includes("Gravity")) await expect(standalone.getByText("GLTF + texture ready")).toBeVisible();
		await standalone.getByRole("button", { name: "Save setting" }).press("Enter");
		await standalone.reload();
		await expect(standalone.locator("#setting")).toContainText("setting");
		await standalone.close();
		app.kill("SIGTERM");
		assert.equal(await app.exited, 0);
		processes.delete(app);
		absent(outside);
	}
	assert.equal(standaloneCalls, 0);
	assert.equal(repoGit(core, "status", "--short", "--untracked-files=all"), globalStatus);
	console.log(JSON.stringify({ productServerContacted: false, standaloneCoreRequests: standaloneCalls,
		independentGitRepositories: 2, standaloneClones: 2, oneHostPreviewListener: true,
		sharedInstallation: "1.0", worksDependencyInstalls: 0, authenticatedApi: true,
		typeErrorUpdatesHostPreview: true, standaloneTypeErrorBlocksBuild: true, hostAndStandaloneAssetsAndStorage: true, registrationMoveAndRemoval: true, watchersAfterClose: 0, busyPreviewStopped: true }));
} finally {
	if (originalHome) process.env.HOME = originalHome;
	await browser?.close();
	for (const app of processes) { app.kill("SIGTERM"); await app.exited; }
	if (module) await module.lifecycle.close?.();
	await server.stop(true);
	for (const port of ports)
		await assert.rejects(() => fetch("http://127.0.0.1:" + port, { signal: AbortSignal.timeout(1_000) }));
	rmSync(scratch, { recursive: true, force: true });
}
