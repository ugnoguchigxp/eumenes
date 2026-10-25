import { z } from "zod";
import type { Hono } from "hono";
import type { OcrService } from "../service";
import { qrCreate } from "../contracts/qr";

export function registerOcrQr(
	app: Hono,
	service: OcrService,
	owner: string,
	incorporate: (
		text: string,
		conversationId: string,
		requestId: string,
	) => Promise<unknown>,
) {
	const root = "/api/ocr/:id/qr";
	function checked(id: string, conversationId: string | undefined) {
		if (
			!conversationId ||
			conversationId.length > 120 ||
			service.get(owner, id).conversationId !== conversationId
		)
			throw new Error("ocr_not_found");
		return id;
	}
	app.post(root, async (c) => {
		const input = qrCreate.safeParse(await c.req.json());
		if (!input.success) return c.json({ error: "invalid_ocr_input" }, 400);
		return c.json(
			await service.qr.create(owner, c.req.param("id"), input.data),
			202,
		);
	});
	app.get(root, (c) => {
		const frame = c.req.query("frameIndex");
		const input = z.coerce
			.number()
			.int()
			.min(0)
			.max(59)
			.optional()
			.safeParse(frame);
		if (!input.success) return c.json({ error: "invalid_ocr_input" }, 400);
		return c.json(
			service.qr.latest(
				owner,
				checked(c.req.param("id"), c.req.query("conversationId")),
				input.data,
			),
		);
	});
	app.get(`${root}/:qrId`, (c) =>
		c.json(
			service.qr.get(
				owner,
				checked(c.req.param("id"), c.req.query("conversationId")),
				c.req.param("qrId"),
			),
		),
	);
	app.post(`${root}/:qrId/cancel`, async (c) => {
		const input = z
			.strictObject({ conversationId: z.string().min(1).max(120) })
			.safeParse(await c.req.json());
		if (!input.success) return c.json({ error: "invalid_ocr_input" }, 400);
		return c.json(
			await service.qr.cancel(
				owner,
				checked(c.req.param("id"), input.data.conversationId),
				c.req.param("qrId"),
			),
		);
	});
	app.post(`${root}/:qrId/conversation`, async (c) => {
		const input = z
			.strictObject({
				requestId: z.uuid(),
				conversationId: z.string().min(1).max(120),
				index: z.number().int().min(0).max(254),
			})
			.safeParse(await c.req.json());
		if (!input.success) return c.json({ error: "invalid_ocr_input" }, 400);
		const value = service.qr.conversationText(
			owner,
			checked(c.req.param("id"), input.data.conversationId),
			c.req.param("qrId"),
			input.data.index,
		);
		return c.json(
			await incorporate(value.text, value.conversationId, input.data.requestId),
		);
	});
}
