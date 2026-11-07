import type { Hono } from "hono";
import { z } from "zod";
import { readBounded } from "../../../infrastructure/bounded-read";
import { limitConcurrency } from "../../../infrastructure/concurrency";
import { parseQuery } from "../../../infrastructure/http";
import {
	isScratchImage,
	scratchId,
	scratchLimits,
	scratchMimes,
	type ScratchItem,
	type ScratchItemResponse,
	type ScratchMime,
} from "../contracts";
import { scratchContentUrl, scratchUri } from "../service/resource-adapter";
import type { ScratchStore } from "../service/store";

/** What the user's own uploads are made by, as the conversation shows it. */
export const USER_MAKER = "利用者";

const byExtension: Record<string, ScratchMime> = {
	md: "text/markdown",
	markdown: "text/markdown",
	txt: "text/plain",
	csv: "text/csv",
	json: "application/json",
	pdf: "application/pdf",
	glb: "model/gltf-binary",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	bmp: "image/bmp",
	webp: "image/webp",
};

/** The file's type: the browser's when it is one the store takes, otherwise by its extension. */
export function fileMime(
	file: Pick<File, "name" | "type">,
): ScratchMime | null {
	const type = file.type.split(";")[0]!.trim().toLowerCase();
	if ((scratchMimes as readonly string[]).includes(type))
		return type as ScratchMime;
	const ext = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase();
	return (ext && byExtension[ext]) || null;
}

export function itemResponse(item: ScratchItem): ScratchItemResponse {
	return {
		...item,
		uri: scratchUri(item.id),
		createdAt: new Date(item.createdAt).toISOString(),
		usedAt: new Date(item.usedAt).toISOString(),
		contentUrl: scratchContentUrl(item.id),
	};
}

const uploadQuery = z.object({ requestId: z.uuid() });

/** `GET /api/scratch/:id`, its content, and the user's file upload (§10). Auth and Origin are the app's. */
export function registerScratch(app: Hono, store: ScratchStore) {
	app.post(
		"/api/conversations/:id/scratch",
		limitConcurrency(2, "scratch_busy"),
		async (c) => {
			const query = parseQuery(c, uploadQuery, {
				code: "invalid_scratch_input",
			});
			if (!query.ok) return query.response;
			const conversationId = c.req.param("id");
			if (!conversationId || conversationId.length > 120)
				return c.json({ error: "invalid_scratch_input" }, 400);
			// Read before the body: a request built without headers derives this from a body not yet consumed.
			const contentType = c.req.header("Content-Type") ?? "";
			const bytes = await readBounded(c.req.raw.body, {
				limit: scratchLimits.itemBytes + 16384,
				missing: "invalid_scratch_input",
				tooLarge: "scratch_too_large",
				signal: AbortSignal.any([
					c.req.raw.signal,
					AbortSignal.timeout(120000),
				]),
			});
			let form: FormData;
			try {
				form = await new Response(new Uint8Array(bytes), {
					headers: { "Content-Type": contentType },
				}).formData();
			} catch {
				return c.json({ error: "invalid_scratch_input" }, 400);
			}
			const file = form.get("file");
			if (!(file instanceof File) || [...form.keys()].length !== 1)
				return c.json({ error: "invalid_scratch_input" }, 400);
			const mime = fileMime(file);
			if (!mime) return c.json({ error: "scratch_type_unsupported" }, 415);
			const item = await store.put({
				id: query.data.requestId,
				conversationId,
				name: file.name || "ファイル",
				mime,
				data: new Uint8Array(await file.arrayBuffer()),
				origin: "attached",
				maker: USER_MAKER,
			});
			return c.json(itemResponse(item), 201);
		},
	);
	app.get("/api/scratch/:id", (c) => {
		const id = scratchId.safeParse(c.req.param("id"));
		const item = id.success ? store.get(id.data) : null;
		if (!item) return c.json({ error: "item_not_found" }, 404);
		return c.json(itemResponse(item), 200, { "Cache-Control": "no-store" });
	});
	app.get("/api/scratch/:id/content", (c) => {
		const id = scratchId.safeParse(c.req.param("id"));
		const found = id.success ? store.file(id.data) : null;
		if (!found) return c.json({ error: "item_not_found" }, 404);
		const { item, path } = found;
		const inline = isScratchImage(item.mime) || item.mime.startsWith("text/");
		return new Response(Bun.file(path), {
			headers: {
				"Content-Type": item.mime.startsWith("text/")
					? `${item.mime}; charset=utf-8`
					: item.mime,
				"Content-Length": String(item.bytes),
				"Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(item.name)}`,
				"X-Content-Type-Options": "nosniff",
				"Content-Security-Policy": "default-src 'none'; sandbox",
				"Cache-Control": "no-store",
			},
		});
	});
}
