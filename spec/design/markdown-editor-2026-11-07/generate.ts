/** Design-only generation: saved settings, discovered service, existing gateway. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createLarmPlayground, findServiceTarget } from "../../../api/domains/larm";
import { resolveLarmToken } from "../../../api/infrastructure/auth-config";
import { liveLarmSettings } from "../../../scripts/live-larm";

const directory = import.meta.dir;
const name = process.argv[2] ?? "concept";
if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error("invalid_asset_name");
const width = Number(process.argv[3] ?? 1280);
const height = Number(process.argv[4] ?? 960);
const manifestPath = `${directory}/${name === "concept" ? "generation" : `${name}.generation`}.json`;
if (await Bun.file(manifestPath).exists()) {
	const previous = await Bun.file(manifestPath).json();
	if (previous.status !== "failed" || previous.generationPosts !== 0)
		throw new Error("generation_already_attempted_check_manifest");
}
const saved = liveLarmSettings();
let posts = 0;
const serviceChecks: unknown[] = [];
const gateway = createLarmPlayground({
	...saved,
	baseUrl: saved.baseUrl ?? undefined,
	voice: saved.voice ?? undefined,
	token: resolveLarmToken(process.env),
	fetch: (async (url, init) => {
		const path = new URL(String(url)).pathname;
		if (init?.method === "POST" && path.endsWith("/images/generations")) {
			posts++;
			if (posts > 1) throw new Error("one_generation_only");
		}
		const response = await fetch(url, init);
		if (response.ok && (path.includes("claim") || (init?.method === "POST" && path.endsWith("/agent-connections")))) {
			const body = await response.clone().json();
			const services = body.services ?? body.connection?.services ?? [];
			serviceChecks.push(...services.map((s: { capability?: string; url?: string; description?: string }) => ({ capability: s.capability, url: s.url, description: s.description })));
		}
		return response;
	}) as typeof fetch,
});
const manifest: Record<string, unknown> = { status: "discovering", generationPosts: 0 };
await mkdir(directory, { recursive: true });
const persist = () => writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
await persist();
try {
	const signal = AbortSignal.timeout(300000);
	const target = findServiceTarget((await gateway.catalog(signal)).targets, "media.image.generate", "larm.image-generation.v1");
	if (!target?.description || !target.endpoint) throw new Error("image_service_unavailable");
	manifest.discovery = { capability: target.capability, protocol: target.protocol, url: target.endpoint, description: target.description };
	manifest.status = "generating";
	await persist();
	console.log(JSON.stringify({ status: "generating", capability: target.capability }));
	const image = await gateway.execute(target, { text: await readFile(`${directory}/${name}.prompt.txt`, "utf8"), width, height, format: "png", seed: 42 }, signal, async (progress) => {
		console.log(JSON.stringify({ phase: progress.phase }));
	});
	if (!image.bytes || image.mime !== "image/png") throw new Error("image_png_missing");
	await writeFile(`${directory}/${name}.png`, image.bytes);
	manifest.status = "saved";
	manifest.bytes = image.bytes.length;
	manifest.generationPosts = posts;
	manifest.serviceChecks = serviceChecks;
	manifest.file = `${name}.png`;
	await persist();
	console.log(JSON.stringify({ status: "saved", file: `${directory}/${name}.png`, bytes: image.bytes.length }));
} catch (error) {
	manifest.status = "failed";
	manifest.error = error instanceof Error ? error.message : "unknown";
	manifest.generationPosts = posts;
	manifest.serviceChecks = serviceChecks;
	await persist();
	throw error;
}
