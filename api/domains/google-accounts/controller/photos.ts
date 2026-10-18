import type { Hono, Context } from "hono";
import type { GoogleAccounts } from "../service";
import { PhotosError } from "../service/photos";

const failure = (c: Context, e: unknown) =>
	c.json(
		{ error: e instanceof PhotosError ? e.code : "photos_unavailable" },
		(e instanceof PhotosError ? e.status : 503) as 400,
	);
export function registerPhotos(app: Hono, service: GoogleAccounts) {
	app.get("/api/google-accounts/photos", (c) => {
		c.header("Cache-Control", "no-store");
		try {
			return c.json(service.photos.status());
		} catch (error) {
			return failure(c, error);
		}
	});
	app.post("/api/google-accounts/photos", async (c) => {
		c.header("Cache-Control", "no-store");
		try {
			return c.json(await service.photos.begin(c.req.raw.signal));
		} catch (error) {
			return failure(c, error);
		}
	});
	app.get("/api/google-accounts/photos/:handle", async (c) => {
		c.header("Cache-Control", "no-store");
		try {
			return c.json(
				await service.photos.read(c.req.param("handle"), c.req.raw.signal),
			);
		} catch (error) {
			return failure(c, error);
		}
	});
	app.delete("/api/google-accounts/photos/:handle", async (c) => {
		c.header("Cache-Control", "no-store");
		try {
			await service.photos.cancel(c.req.param("handle"), c.req.raw.signal);
			return c.json({ cancelled: true });
		} catch (error) {
			return failure(c, error);
		}
	});
	app.get(
		"/api/google-accounts/photos/:handle/items/:id/content",
		async (c) => {
			try {
				const file = await service.photos.file(
					c.req.param("handle"),
					c.req.param("id"),
					c.req.raw.signal,
					true,
				);
				return new Response(await file.arrayBuffer(), {
					headers: {
						"Content-Type": file.type,
						"Cache-Control": "no-store",
						"X-Content-Type-Options": "nosniff",
					},
				});
			} catch (error) {
				return failure(c, error);
			}
		},
	);
}
