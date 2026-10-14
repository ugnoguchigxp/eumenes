import { z } from "zod";
import type { Hono } from "hono";
import { readBounded } from "../../../infrastructure/bounded-read";
import { maxInputBytes } from "../contracts";
import type { OcrService } from "../service";
export function registerOcr(
	app: Hono,
	service: OcrService,
	owner: string,
	incorporate: (
		text: string,
		conversationId: string,
		requestId: string,
	) => Promise<unknown>,
) {
	const root = "/api/ocr";
	app.get(root, (c) =>
		c.json(service.list(owner, c.req.query("conversationId") ?? "main")),
	);
	app.post(root, async (c) => {
		const query = z
			.object({
				requestId: z.uuid(),
				conversationId: z.string().min(1).max(120),
			})
			.safeParse(c.req.query());
		if (!query.success) return c.json({ error: "invalid_ocr_input" }, 400);
		const bytes = await readBounded(c.req.raw.body, {
			limit: maxInputBytes + 16384,
			missing: "invalid_ocr_input",
			tooLarge: "payload_too_large",
			signal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30000)]),
		});
		let form: FormData;
		try {
			form = await new Response(new Uint8Array(bytes), {
				headers: { "Content-Type": c.req.header("Content-Type") ?? "" },
			}).formData();
		} catch {
			return c.json({ error: "invalid_ocr_input" }, 400);
		}
		const file = form.get("file");
		if (!(file instanceof File) || [...form.keys()].length !== 1)
			return c.json({ error: "invalid_ocr_input" }, 400);
		return c.json(
			await service.upload(
				owner,
				query.data.conversationId,
				file,
				query.data.requestId,
			),
			202,
		);
	});
	app.get(`${root}/:id`, (c) => c.json(service.get(owner, c.req.param("id"))));
	app.get(`${root}/:id/content`, (c) => {
		const file = service.content(owner, c.req.param("id"));
		return new Response(new Uint8Array(file.bytes), {
			headers: {
				"Content-Type": file.mime,
				"Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff",
			},
		});
	});
	app.post(`${root}/:id/cancel`, async (c) =>
		c.json(await service.cancel(owner, c.req.param("id"))),
	);
	app.post(`${root}/:id/recheck`, async (c) =>
		c.json(await service.recheck(owner, c.req.param("id"))),
	);
	app.delete(`${root}/:id`, async (c) => {
		await service.remove(owner, c.req.param("id"));
		return c.body(null, 204);
	});
	app.post(`${root}/:id/conversation`, async (c) => {
		const input = z
			.strictObject({
				requestId: z.uuid(),
				frameIndex: z.number().int().nonnegative().max(59).optional(),
				lineIndexes: z
					.array(z.number().int().nonnegative().max(9999))
					.max(10000)
					.optional(),
			})
			.safeParse(await c.req.json());
		if (!input.success) return c.json({ error: "invalid_ocr_input" }, 400);
		const id = c.req.param("id");
		const v = service.get(owner, id);
		return c.json(
			await incorporate(
				service.conversationText(
					owner,
					id,
					input.data.frameIndex,
					input.data.lineIndexes,
				),
				v.conversationId,
				input.data.requestId,
			),
		);
	});
}
