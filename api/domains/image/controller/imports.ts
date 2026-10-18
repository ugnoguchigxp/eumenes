import type { Hono } from "hono";
import { z } from "zod";
import { readBounded } from "../../../infrastructure/bounded-read";
import type { ImageService } from "../service";

const errors: Record<string, number> = {
	image_invalid: 400,
	image_format_unsupported: 415,
	image_mime_mismatch: 415,
	image_too_large: 413,
	image_dimensions_exceeded: 413,
	invalid_import_request: 400,
	image_import_not_found: 404,
	idempotency_conflict: 409,
	image_import_capacity: 429,
	image_import_connection_changed: 409,
};
export function registerImageImports(
	app: Hono,
	service: Pick<ImageService, "imports">,
) {
	app.post("/api/images/imports", async (c) => {
		c.header("Cache-Control", "no-store");
		const id = z.uuid().safeParse(c.req.query("requestId"));
		if (!id.success) return c.json({ error: "invalid_import_request" }, 400);
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
				await service.imports.upload(id.data, file, c.req.raw.signal),
			);
		} catch (error) {
			const code =
				error instanceof Error && error.message in errors
					? error.message
					: "image_import_unavailable";
			return c.json({ error: code }, (errors[code] ?? 503) as 400);
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
				const code =
					error instanceof Error && error.message in errors
						? error.message
						: "image_import_unavailable";
				return c.json({ error: code }, (errors[code] ?? 503) as 400);
			}
		});
	}
}
