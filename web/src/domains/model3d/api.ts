import type { z } from "zod";
import type { EumenesClient } from "../../../../client";
import {
	createTransport,
	json,
	type Transport,
} from "../../../../client/transport";
import {
	assetsPageSize,
	maxGlbBytes,
	model3dAsset,
	model3dAssetPage,
	model3dGeneration,
	model3dGenerationList,
	model3dStatus,
	type Model3dGenerateBody,
	type Model3dQuery,
} from "./contracts";

export class GlbTooLargeError extends Error {
	constructor() {
		super("model3d_glb_too_large");
	}
}

/** Reads a GLB body, refusing anything over the cap before or while it streams. */
async function readCapped(response: Response, limit: number) {
	const declared = Number(response.headers.get("Content-Length"));
	if (Number.isFinite(declared) && declared > limit)
		throw new GlbTooLargeError();
	if (!response.body) {
		const bytes = await response.arrayBuffer();
		if (bytes.byteLength > limit) throw new GlbTooLargeError();
		return bytes;
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > limit) {
			await reader.cancel();
			throw new GlbTooLargeError();
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes.buffer;
}

export function model3dApi(t: Transport) {
	const read = async <S extends z.ZodType>(
		schema: S,
		path: string,
		init?: RequestInit,
	): Promise<z.output<S>> =>
		schema.parse(await (await t.call(path, init)).json());
	const asset = (id: string) => `/api/model3d/assets/${encodeURIComponent(id)}`;
	const generation = (id: string) =>
		`/api/model3d/generations/${encodeURIComponent(id)}`;
	return {
		status: (signal?: AbortSignal) =>
			read(model3dStatus, "/api/model3d/status", { signal }),
		generations: async (signal?: AbortSignal) =>
			(
				await read(model3dGenerationList, "/api/model3d/generations", {
					signal,
				})
			).generations,
		createGeneration: (body: Model3dGenerateBody) =>
			read(model3dGeneration, "/api/model3d/generations", json(body)),
		cancelGeneration: (id: string) =>
			read(model3dGeneration, `${generation(id)}/cancel`, { method: "POST" }),
		recheckGeneration: (id: string) =>
			read(model3dGeneration, `${generation(id)}/recheck`, { method: "POST" }),
		assets: (query: Model3dQuery, cursor?: string, signal?: AbortSignal) => {
			const params = new URLSearchParams({
				sort: query.sort,
				order: query.order,
				limit: String(assetsPageSize),
			});
			if (query.q) params.set("q", query.q);
			if (query.tags.length) params.set("tags", query.tags.join(","));
			if (cursor) params.set("cursor", cursor);
			return read(model3dAssetPage, `/api/model3d/assets?${params}`, {
				signal,
			});
		},
		asset: (id: string, signal?: AbortSignal) =>
			read(model3dAsset, asset(id), { signal }),
		updateAsset: (id: string, patch: { title?: string; tags?: string[] }) =>
			read(model3dAsset, asset(id), { ...json(patch), method: "PATCH" }),
		deleteAsset: async (id: string) => {
			await t.call(asset(id), { method: "DELETE" });
		},
		/** The GLB bytes through the authenticated transport; never a URL with a credential. */
		assetContent: async (id: string, signal?: AbortSignal) =>
			readCapped(await t.call(`${asset(id)}/content`, { signal }), maxGlbBytes),
	};
}
export type Model3dApi = ReturnType<typeof model3dApi>;

const apis = new WeakMap<EumenesClient, Model3dApi>();
/**
 * The model3d endpoints for the app's client. The client carries no credential of its own
 * (the host proxy adds it), so the same origin transport reaches the same API.
 */
export function model3dApiFor(client: EumenesClient): Model3dApi {
	let api = apis.get(client);
	if (!api) {
		api = model3dApi(createTransport(client.identity));
		apis.set(client, api);
	}
	return api;
}
