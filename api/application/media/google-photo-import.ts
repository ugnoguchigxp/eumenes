import type { Hono } from "hono";
import { z } from "zod";
import { parseJsonBody } from "../../infrastructure/http";
import type { ImageService } from "../../domains/image";
import type { GoogleAccounts } from "../../domains/google-accounts";

const importInput = z.strictObject({
	handle: z.uuid(),
	itemId: z.string().min(1).max(2048),
});

const forwarded = new Set([
	"photos_session_changed",
	"photos_session_expired",
	"photos_authorization_required",
	"photos_image_unsupported",
	"photos_image_too_large",
	"image_dimensions_exceeded",
	"image_invalid",
	"image_too_large",
]);

/** Application composition connects public operations; each domain owns its storage and policy. */
export function registerGooglePhotoImport(
	app: Hono,
	image: Pick<ImageService, "imports">,
	google: { photos: Pick<GoogleAccounts["photos"], "file" | "assertCurrent"> },
) {
	app.post("/api/images/imports/:id/google-photo", async (c) => {
		c.header("Cache-Control", "no-store");
		const id = z.uuid().safeParse(c.req.param("id"));
		const input = await parseJsonBody(c, importInput, {
			code: "invalid_import_request",
		});
		if (!input.ok) return input.response;
		if (!id.success) return c.json({ error: "invalid_import_request" }, 400);
		try {
			google.photos.assertCurrent(input.data.handle);
			try {
				return c.json(await image.imports.resume(id.data, c.req.raw.signal));
			} catch (error) {
				if (
					!(error instanceof Error) ||
					error.message !== "image_import_not_found"
				)
					throw error;
			}
			const { handle, itemId } = input.data;
			const file = await google.photos.file(handle, itemId, c.req.raw.signal);
			google.photos.assertCurrent(handle);
			const result = await image.imports.upload(
				id.data,
				file,
				c.req.raw.signal,
			);
			google.photos.assertCurrent(handle);
			return c.json(result);
		} catch (error) {
			// These codes carry their own status (the Photos and image tables); anything else is the import being unavailable.
			if (error instanceof Error && forwarded.has(error.message)) throw error;
			return c.json({ error: "photos_import_unavailable" }, 409);
		}
	});
}
