import { expect, test } from "bun:test";
import { createLarmPlayground } from "../service/playground";
import { MeshHttpError } from "../service/mesh-library";

const base = "http://127.0.0.1:18799";
type Seen = { url: string; method: string; headers: Headers; body?: string };
function larm(route: (url: URL, init: RequestInit) => Response) {
	const seen: Seen[] = [];
	const fetcher = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const url = new URL(String(input));
		seen.push({
			url: url.pathname + url.search,
			method: init.method ?? "GET",
			headers: new Headers(init.headers),
			body: typeof init.body === "string" ? init.body : undefined,
		});
		return route(url, init);
	}) as typeof fetch;
	const meshes = createLarmPlayground({
		baseUrl: base,
		token: "control-token",
		audience: "lan",
		fetch: fetcher,
	}).meshes;
	return { meshes, seen };
}
const json = (
	value: unknown,
	status = 200,
	headers: Record<string, string> = {},
) =>
	new Response(JSON.stringify(value), {
		status,
		headers: { "Content-Type": "application/json", ...headers },
	});
const catalog = (services: unknown[]) => ({
	contractVersion: "agent-connection.v3",
	catalogRevision: "r1",
	profiles: [],
	services,
});
const mesh = {
	name: "mesh",
	capability: "media.mesh.generate",
	protocol: "larm.mesh-generation.v1",
	model: "catalog-mesh-model",
	url: `${base}/v1/3d/generations`,
	description: "512固定",
};
const image = {
	name: "image",
	capability: "media.image.generate",
	protocol: "larm.image-generation.v1",
	model: "catalog-image-model",
	url: `${base}/v1/images/generations`,
};
const signal = () => new AbortController().signal;

test("the services are found by capability and protocol in the catalog's root list", async () => {
	const { meshes, seen } = larm(() =>
		json(
			catalog([{ ...mesh, name: "renamed", capability: "other" }, mesh, image]),
		),
	);
	expect(await meshes.discover(signal())).toEqual({
		mesh: { model: "catalog-mesh-model", path: "/v1/3d/generations" },
		image: { model: "catalog-image-model", path: "/v1/images/generations" },
	});
	expect(seen[0]!.url).toBe("/v3/agent-profiles");
	expect(seen[0]!.headers.get("Authorization")).toBe("Bearer control-token");
});

test("a missing service is null and a URL on another origin is refused", async () => {
	expect(
		await larm(() => json(catalog([image]))).meshes.discover(signal()),
	).toEqual({
		mesh: null,
		image: { model: "catalog-image-model", path: "/v1/images/generations" },
	});
	await expect(
		larm(() =>
			json(
				catalog([{ ...mesh, url: "http://elsewhere.test/v1/3d/generations" }]),
			),
		).meshes.discover(signal()),
	).rejects.toThrow();
});

test("a submission carries the idempotency key and no steps; 429 reports Retry-After", async () => {
	const body = {
		model: "catalog-mesh-model",
		source: {
			type: "prompt" as const,
			prompt: "ロボット",
			imageModel: "catalog-image-model",
		},
		title: "ロボット",
		tags: ["試作"],
		resolution: 512 as const,
		seed: 42,
	};
	const ok = larm(() =>
		json({ jobId: "job_1", statusUrl: "/v1/3d/generations/job_1" }, 202),
	);
	expect(
		await ok.meshes.submit("/v1/3d/generations", body, "key-1", signal()),
	).toBe("job_1");
	expect(ok.seen[0]!.method).toBe("POST");
	expect(ok.seen[0]!.headers.get("Idempotency-Key")).toBe("key-1");
	expect(JSON.parse(ok.seen[0]!.body!)).toEqual(body);

	const busy = larm(() => json({ error: "busy" }, 429, { "Retry-After": "7" }));
	const refused = await busy.meshes
		.submit("/v1/3d/generations", body, "key-1", signal())
		.catch((e) => e);
	expect(refused).toBeInstanceOf(MeshHttpError);
	expect(refused).toMatchObject({ status: 429, retryAfterMs: 7000 });
});

test("job status keeps stage and status apart; assets are reduced to known fields", async () => {
	const { meshes } = larm((url) =>
		url.pathname.startsWith("/v1/3d/generations/")
			? json({ jobId: "job_1", status: "running", stage: "waiting_gpu" })
			: json({
					assets: [
						{
							id: "asset_1",
							title: "ロボット",
							tags: ["ロボット"],
							createdAt: "2026-10-18T00:00:00Z",
							source: { type: "prompt", prompt: "白い背景のロボット" },
							warnings: [{ code: "dark_texture", message: "テクスチャが暗い" }],
							urls: { source: "/v1/3d/assets/asset_1/source" },
							secret: "ignored",
						},
					],
					total: 1,
					nextCursor: null,
				}),
	);
	expect(
		await meshes.job("/v1/3d/generations", "job_1", signal()),
	).toMatchObject({
		status: "running",
		stage: "waiting_gpu",
	});
	expect(
		(await meshes.assets({ q: "ロボット", tags: ["a", "b"] }, signal())).assets,
	).toEqual([
		{
			id: "asset_1",
			title: "ロボット",
			tags: ["ロボット"],
			createdAt: "2026-10-18T00:00:00Z",
			prompt: "白い背景のロボット",
			warnings: ["テクスチャが暗い"],
			hasSource: true,
		},
	]);
});

test("content must be a GLB", async () => {
	const glb = larm(
		() =>
			new Response(new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0]), {
				headers: { "Content-Type": "model/gltf-binary" },
			}),
	);
	expect((await glb.meshes.content("asset_1", signal())).mime).toBe(
		"model/gltf-binary",
	);
	const html = larm(
		() => new Response("<html>", { headers: { "Content-Type": "text/html" } }),
	);
	await expect(html.meshes.content("asset_1", signal())).rejects.toThrow(
		"invalid_mesh_content_type",
	);
});
