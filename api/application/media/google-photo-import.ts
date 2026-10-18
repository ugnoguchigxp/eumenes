import type { Hono } from "hono";
import { z } from "zod";
import type { ImageService } from "../../domains/image";
import type { GoogleAccounts } from "../../domains/google-accounts";

/** Application composition connects public operations; each domain owns its storage and policy. */
export function registerGooglePhotoImport(
	app: Hono,
	image: Pick<ImageService, "imports">,
	google: { photos: Pick<GoogleAccounts["photos"], "file" | "assertCurrent"> },
) {
	app.post("/api/images/imports/:id/google-photo", async (c) => {
		c.header("Cache-Control", "no-store");
		const id = z.uuid().safeParse(c.req.param("id"));
		const input = z
			.strictObject({ handle: z.uuid(), itemId: z.string().min(1).max(2048) })
			.safeParse(await c.req.json().catch(() => null));
		if (!id.success || !input.success)
			return c.json({ error: "invalid_import_request" }, 400);
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
			const code =
				error instanceof Error &&
				[
					"photos_session_changed",
					"photos_session_expired",
					"photos_authorization_required",
					"photos_image_unsupported",
					"photos_image_too_large",
					"image_dimensions_exceeded",
					"image_invalid",
					"image_too_large",
				].includes(error.message)
					? error.message
					: "photos_import_unavailable";
			return c.json(
				{ error: code },
				[
					"image_too_large",
					"image_dimensions_exceeded",
					"photos_image_too_large",
				].includes(code)
					? 413
					: code === "photos_image_unsupported"
						? 415
						: code === "image_invalid"
							? 400
							: code === "photos_session_expired"
								? 410
								: 409,
			);
		}
	});
}
