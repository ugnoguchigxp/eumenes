import { registerOcrAnalyses } from "./analyses";
import { z } from "zod";
import type { Hono } from "hono";
import { readBounded } from "../../../infrastructure/bounded-read";
import { correctionCreate, maxInputBytes } from "../contracts";
import type { OcrService } from "../service";
import { registerOcrQr } from "./qr";
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
	if (service.analyses) registerOcrAnalyses(app, service.analyses, owner);
	registerOcrQr(app, service, owner, incorporate);
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
	if (service.corrections) {
		const corrections = service.corrections;
		const checkedSource = (id: string, conversationId: string | undefined) => {
			if (
				!conversationId ||
				conversationId.length > 120 ||
				service.get(owner, id).conversationId !== conversationId
			)
				throw new Error("ocr_not_found");
			return id;
		};
		app.post(`${root}/:id/corrections`, async (c) => {
			const input = correctionCreate.safeParse(await c.req.json());
			if (!input.success) return c.json({ error: "invalid_ocr_input" }, 400);
			return c.json(
				await corrections.create(owner, c.req.param("id"), input.data),
				202,
			);
		});
		app.get(`${root}/:id/corrections`, (c) => {
			const frame = c.req.query("frameIndex");
			const cursor = c.req.query("before");
			const frameIndex = frame === undefined ? undefined : Number(frame);
			const before = cursor === undefined ? undefined : Number(cursor);
			if (
				(frame !== undefined &&
					(!Number.isInteger(frameIndex) ||
						frameIndex! < 0 ||
						frameIndex! > 59)) ||
				(cursor !== undefined && (!Number.isSafeInteger(before) || before! < 1))
			)
				return c.json({ error: "invalid_ocr_input" }, 400);
			return c.json(
				corrections.list(
					owner,
					checkedSource(c.req.param("id"), c.req.query("conversationId")),
					frameIndex,
					before,
				),
			);
		});
		app.get(`${root}/:id/corrections/:candidateId`, (c) =>
			c.json(
				corrections.get(
					owner,
					c.req.param("candidateId"),
					checkedSource(c.req.param("id"), c.req.query("conversationId")),
				),
			),
		);
		app.post(`${root}/:id/corrections/:candidateId/cancel`, async (c) => {
			const input = z
				.strictObject({ conversationId: z.string().min(1).max(120) })
				.safeParse(await c.req.json());
			if (!input.success) return c.json({ error: "invalid_ocr_input" }, 400);
			return c.json(
				await corrections.cancel(
					owner,
					c.req.param("candidateId"),
					checkedSource(c.req.param("id"), input.data.conversationId),
				),
			);
		});
		app.put(`${root}/:id/corrections/preference`, async (c) => {
			const input = z
				.strictObject({
					conversationId: z.string().min(1).max(120),
					frameIndex: z.number().int().nonnegative().max(59).optional(),
					preferredId: z.uuid().nullable(),
					expectedRevision: z.number().int().nonnegative(),
				})
				.safeParse(await c.req.json());
			if (!input.success) return c.json({ error: "invalid_ocr_input" }, 400);
			return c.json(
				await corrections.prefer(
					owner,
					checkedSource(c.req.param("id"), input.data.conversationId),
					input.data.frameIndex,
					input.data.preferredId,
					input.data.expectedRevision,
				),
			);
		});
		app.post(`${root}/:id/corrections/:candidateId/conversation`, async (c) => {
			const input = z
				.strictObject({
					requestId: z.uuid(),
					conversationId: z.string().min(1).max(120),
				})
				.safeParse(await c.req.json());
			if (!input.success) return c.json({ error: "invalid_ocr_input" }, 400);
			const value = corrections.conversationText(
				owner,
				c.req.param("candidateId"),
				checkedSource(c.req.param("id"), input.data.conversationId),
			);
			return c.json(
				await incorporate(
					value.text,
					value.conversationId,
					input.data.requestId,
				),
			);
		});
	}
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
