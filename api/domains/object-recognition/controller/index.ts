import { registerRecognitionAnalyses } from "./analyses";
import { z } from "zod";
import type { Hono } from "hono";
import { readBounded } from "../../../infrastructure/bounded-read";
import { maxInputBytes } from "../contracts";
import type { ObjectRecognitionService } from "../service";
import type { ImageMaterial } from "../service/handoff";
/** Conversation operations the application layer composes; this domain never imports them. */
export type RecognitionSharing = {
	/** A pending chat attachment (image + detections) for the composer; nothing is sent. */
	attach(material: ImageMaterial, requestId: string): Promise<unknown>;
	/** Sends the image with detections as a new user message; idempotent per handoff. */
	send(
		material: ImageMaterial,
		question: string,
		handoffId: string,
		/** Throws when the request was closed meanwhile; called just before the message is sent. */
		ensureOpen: () => void,
	): Promise<unknown>;
};
const requestBody = z.strictObject({ requestId: z.uuid() });
export function registerObjectRecognition(
	app: Hono,
	service: ObjectRecognitionService,
	owner: string,
	sharing: RecognitionSharing,
) {
	const root = "/api/object-recognition";
	if (service.analyses)
		registerRecognitionAnalyses(app, service.analyses, owner);
	app.get(`${root}/commands`, (c) =>
		c.json(service.commands(owner, c.req.query("conversationId") ?? "main")),
	);
	app.get(root, (c) =>
		c.json(service.list(owner, c.req.query("conversationId") ?? "main")),
	);
	app.get(`${root}/handoffs`, (c) =>
		c.json(service.handoffs(owner, c.req.query("conversationId") ?? "main")),
	);
	app.post(`${root}/handoffs/:id/cancel`, async (c) =>
		c.json(await service.cancelHandoff(owner, c.req.param("id"))),
	);
	app.post(`${root}/handoffs/:id/send`, async (c) => {
		const input = z
			.strictObject({ recognitionId: z.uuid().optional() })
			.safeParse(await c.req.json().catch(() => null));
		if (!input.success)
			return c.json({ error: "invalid_recognition_input" }, 400);
		const id = c.req.param("id");
		const { material, question } = await service.handoffMaterial(
			owner,
			id,
			input.data.recognitionId,
		);
		// A request cancelled while the image was being prepared is not sent.
		const run = await sharing.send(material, question, id, () =>
			service.assertHandoffOpen(owner, id),
		);
		await service.completeHandoff(owner, id);
		return c.json(run);
	});
	app.post(root, async (c) => {
		const query = z
			.object({
				requestId: z.uuid(),
				conversationId: z.string().min(1).max(120),
				origin: z.enum(["camera", "screen", "file"]).optional(),
				handoffId: z.string().min(1).max(120).optional(),
			})
			.safeParse(c.req.query());
		if (!query.success)
			return c.json({ error: "invalid_recognition_input" }, 400);
		const bytes = await readBounded(c.req.raw.body, {
			limit: maxInputBytes + 16384,
			missing: "invalid_recognition_input",
			tooLarge: "payload_too_large",
			signal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30000)]),
		});
		let form: FormData;
		try {
			form = await new Response(new Uint8Array(bytes), {
				headers: { "Content-Type": c.req.header("Content-Type") ?? "" },
			}).formData();
		} catch {
			return c.json({ error: "invalid_recognition_input" }, 400);
		}
		const file = form.get("file");
		if (!(file instanceof File) || [...form.keys()].length !== 1)
			return c.json({ error: "invalid_recognition_input" }, 400);
		return c.json(
			await service.upload(
				owner,
				query.data.conversationId,
				file,
				query.data.requestId,
				query.data.origin,
				query.data.handoffId,
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
	app.post(`${root}/:id/attachment`, async (c) => {
		const input = requestBody.safeParse(await c.req.json().catch(() => null));
		if (!input.success)
			return c.json({ error: "invalid_recognition_input" }, 400);
		const material = service.attachmentMaterial(owner, c.req.param("id"));
		return c.json(await sharing.attach(material, input.data.requestId));
	});
}
