import type { Context, Hono } from "hono";
import { z } from "zod";
import { readBounded } from "../../../infrastructure/bounded-read";
import { parseQuery } from "../../../infrastructure/http";
import type { ImageService } from "../service";
import { errorStatus } from "../contracts";

const uploadQuery = z.object({ requestId: z.uuid() });
/** An image code carries its own status (the application's error handler); anything else is the import being unavailable. */
function unavailable(c: Context, error: unknown) {
	if (error instanceof Error && Object.hasOwn(errorStatus, error.message))
		throw error;
	return c.json({ error: "image_import_unavailable" }, 503);
}
export function registerImageImports(
	app: Hono,
	service: Pick<ImageService, "imports">,
) {
	app.post("/api/images/imports", async (c) => {
		c.header("Cache-Control", "no-store");
		const query = parseQuery(c, uploadQuery, {
			code: "invalid_import_request",
		});
		if (!query.ok) return query.response;
		try {
			const bytes = await readBounded(c.req.raw.body, {
				limit: 16 * 1024 * 1024 + 65536,
				tooLarge: "image_too_large",
				missing: "invalid_import_request",
				signal: c.req.raw.signal,
			});
			const form = await new Response(new Uint8Array(bytes), {
				headers: { "Content-Type": c.req.header("Content-Type") ?? "" },
			})
				.formData()
				.catch(() => {
					throw new Error("invalid_import_request");
				});
			const file = form.get("file");
			if (!(file instanceof File) || [...form.keys()].length !== 1)
				throw new Error("invalid_import_request");
			return c.json(
				await service.imports.upload(
					query.data.requestId,
					file,
					c.req.raw.signal,
				),
			);
		} catch (error) {
			return unavailable(c, error);
		}
	});
	for (const method of ["read", "resume"] as const) {
		const path = `/api/images/imports/:id${method === "resume" ? "/resume" : ""}`;
		app.on(method === "read" ? "GET" : "POST", path, async (c) => {
			c.header("Cache-Control", "no-store");
			const id = z.uuid().safeParse(c.req.param("id"));
			if (!id.success) return c.json({ error: "invalid_import_request" }, 400);
			try {
				return c.json(await service.imports[method](id.data, c.req.raw.signal));
			} catch (error) {
				return unavailable(c, error);
			}
		});
	}
}
