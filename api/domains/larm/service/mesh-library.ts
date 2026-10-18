import {
	MESH_CAPABILITY,
	MESH_GENERATIONS_PATH,
	MESH_IMAGE_CAPABILITY,
	MESH_IMAGE_PROTOCOL,
	MESH_PROTOCOL,
	meshAccepted,
	meshAsset,
	meshAssetPage,
	meshAssetPatch,
	meshAssetQuery,
	meshCatalog,
	meshCatalogService,
	meshGenerationRequest,
	meshId,
	meshJob,
	type MeshAssetPatch,
	type MeshAssetQuery,
	type MeshGenerationRequest,
} from "../contracts/mesh";
import { bytes, json } from "./playground-http";

type Control = (
	path: string,
	signal: AbortSignal,
	init?: RequestInit,
	accepted?: number[],
) => Promise<Response>;

const GLB_LIMIT = 64 * 1024 * 1024;
const IMAGE_LIMIT = 32 * 1024 * 1024;
const enc = encodeURIComponent;

/** A refusal LARM explained: the status, its own code and when to come back (429). */
export class MeshHttpError extends Error {
	constructor(
		readonly status: number,
		readonly reason: string | null,
		readonly retryAfterMs: number | null,
	) {
		super(`larm_http_${status}`);
	}
}
async function refusal(r: Response) {
	const retry = Number(r.headers.get("retry-after"));
	let reason: string | null = null;
	try {
		const body = await json(r);
		const value = body.code ?? body.error ?? body.reason;
		const text =
			typeof value === "string"
				? value
				: value && typeof value === "object" && "code" in value
					? String((value as { code: unknown }).code)
					: null;
		reason = text && /^[a-z0-9_.-]{1,64}$/i.test(text) ? text : null;
	} catch {
		await r.body?.cancel().catch(() => {});
	}
	return new MeshHttpError(
		r.status,
		reason,
		Number.isFinite(retry) && retry > 0 ? Math.min(retry, 600) * 1000 : null,
	);
}

/**
 * LARM's 3D generation and asset API over the Control origin and its Bearer. The service is found by
 * capability and protocol in the catalog; its model and URL are the catalog's, never Eumenes'.
 */
export function createMeshLibrary(
	control: Control,
	publicUrl: (path: string) => URL,
) {
	const refusals = [400, 401, 403, 404, 409, 422, 429, 503, 507];
	async function call(
		path: string,
		signal: AbortSignal,
		init: RequestInit = {},
		ok = [200],
	) {
		const r = await control(path, signal, init, [...ok, ...refusals]);
		if (!ok.includes(r.status)) throw await refusal(r);
		return r;
	}
	async function media(path: string, signal: AbortSignal, image: boolean) {
		const r = await call(path, signal);
		const mime = r.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
		const allowed = image
			? ["image/png", "image/webp", "image/jpeg"]
			: ["model/gltf-binary", "application/octet-stream"];
		if (!allowed.includes(mime)) {
			await r.body?.cancel();
			throw new Error("invalid_mesh_content_type");
		}
		const content = await bytes(r, image ? IMAGE_LIMIT : GLB_LIMIT);
		if (!image && new TextDecoder().decode(content.slice(0, 4)) !== "glTF")
			throw new Error("invalid_mesh_content");
		return { bytes: content, mime: image ? mime : "model/gltf-binary" };
	}
	return {
		/** The 3D service and the image service of the current catalog; absent ones are `null`. */
		async discover(signal: AbortSignal) {
			const body = await json(await call("/v3/agent-profiles", signal));
			try {
				const catalog = meshCatalog.parse(body);
				const find = (capability: string, protocol: string) => {
					for (const item of catalog.services) {
						const s = meshCatalogService.safeParse(item);
						if (
							!s.success ||
							s.data.capability !== capability ||
							s.data.protocol !== protocol
						)
							continue;
						// The URL must be on the saved Control origin.
						return {
							model: s.data.model,
							path: publicUrl(s.data.url).pathname,
						};
					}
					return null;
				};
				const mesh = find(MESH_CAPABILITY, MESH_PROTOCOL);
				// Job and cancel paths are built under it, so it must be exactly LARM's generation path.
				if (mesh && mesh.path !== MESH_GENERATIONS_PATH)
					throw new Error("invalid_mesh_service");
				return {
					mesh,
					image: find(MESH_IMAGE_CAPABILITY, MESH_IMAGE_PROTOCOL),
				};
			} catch {
				throw new Error("invalid_mesh_service");
			}
		},
		async submit(
			path: string,
			body: MeshGenerationRequest,
			idempotencyKey: string,
			signal: AbortSignal,
		) {
			const r = await call(
				path,
				signal,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"Idempotency-Key": idempotencyKey,
					},
					body: JSON.stringify(meshGenerationRequest.parse(body)),
				},
				[200, 201, 202],
			);
			return meshAccepted.parse(await json(r)).jobId;
		},
		async job(path: string, jobId: string, signal: AbortSignal) {
			meshId.parse(jobId);
			const j = meshJob.parse(
				await json(await call(`${path}/${enc(jobId)}`, signal)),
			);
			if (j.jobId !== jobId) throw new Error("invalid_mesh_job");
			return j;
		},
		async cancel(path: string, jobId: string, signal: AbortSignal) {
			meshId.parse(jobId);
			await call(
				`${path}/${enc(jobId)}`,
				signal,
				{ method: "DELETE" },
				[200, 202, 204],
			).then((r) => r.body?.cancel());
		},
		async assets(query: MeshAssetQuery, signal: AbortSignal) {
			const q = meshAssetQuery.parse(query);
			const params = new URLSearchParams();
			if (q.q) params.set("q", q.q);
			if (q.tags?.length) params.set("tags", q.tags.join(","));
			if (q.sort) params.set("sort", q.sort);
			if (q.order) params.set("order", q.order);
			if (q.limit) params.set("limit", String(q.limit));
			if (q.cursor) params.set("cursor", q.cursor);
			const page = meshAssetPage.parse(
				await json(
					await call(`/v1/3d/assets${params.size ? `?${params}` : ""}`, signal),
				),
			);
			return {
				assets: page.assets.map((a) => meshAsset.parse(a)),
				total: page.total,
				nextCursor: page.nextCursor ?? null,
			};
		},
		async asset(id: string, signal: AbortSignal) {
			meshId.parse(id);
			const a = meshAsset.parse(
				await json(await call(`/v1/3d/assets/${enc(id)}`, signal)),
			);
			if (a.id !== id) throw new Error("invalid_mesh_asset");
			return a;
		},
		async update(id: string, patch: MeshAssetPatch, signal: AbortSignal) {
			meshId.parse(id);
			const r = await call(`/v1/3d/assets/${enc(id)}`, signal, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(meshAssetPatch.parse(patch)),
			});
			const a = meshAsset.parse(await json(r));
			if (a.id !== id) throw new Error("invalid_mesh_asset");
			return a;
		},
		async remove(id: string, signal: AbortSignal) {
			meshId.parse(id);
			await call(
				`/v1/3d/assets/${enc(id)}`,
				signal,
				{ method: "DELETE" },
				[200, 204],
			).then((r) => r.body?.cancel());
		},
		content: (id: string, signal: AbortSignal) =>
			media(`/v1/3d/assets/${enc(meshId.parse(id))}/content`, signal, false),
		source: (id: string, signal: AbortSignal) =>
			media(`/v1/3d/assets/${enc(meshId.parse(id))}/source`, signal, true),
	};
}
export type MeshLibrary = ReturnType<typeof createMeshLibrary>;
