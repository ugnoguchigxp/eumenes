import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import sharp from "sharp";
import { registerLibraryAttachment } from "./library-attachment";

const requestId = "0b6f8a52-3c1e-4d7a-9f00-1a2b3c4d5e6f";
const image = (format: "png" | "webp") =>
	sharp({
		create: {
			width: 32,
			height: 16,
			channels: 4,
			background: { r: 10, g: 120, b: 200, alpha: 0.5 },
		},
	})
		[format]()
		.toBuffer();

function app(
	content: (id: string) => Promise<{ bytes?: Uint8Array; mime?: string }>,
) {
	const uploads: { conversationId: string; id: string; file: File }[] = [];
	const hono = new Hono();
	registerLibraryAttachment(
		hono,
		{ content: (id) => content(id) as never },
		{
			uploadAttachment: async (conversationId, id, file) => {
				uploads.push({ conversationId, id, file });
				return { id, conversationId, name: file.name } as never;
			},
		},
	);
	const post = (body: unknown, conversation = "main") =>
		hono.request(`/api/conversations/${conversation}/attachments/library`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	return { post, uploads };
}

describe("library image attachments", () => {
	test("a WebP library image becomes a JPEG attachment under the request id", async () => {
		const bytes = await image("webp");
		const seen: string[] = [];
		const { post, uploads } = app(async (id) => {
			seen.push(id);
			return { bytes, mime: "image/webp" };
		});
		const res = await post({ requestId, imageId: "img-1" });
		expect(res.status).toBe(201);
		expect(await res.json()).toMatchObject({
			id: requestId,
			conversationId: "main",
		});
		expect(seen).toEqual(["img-1"]);
		expect(uploads).toHaveLength(1);
		const file = uploads[0]!.file;
		expect(file.type).toBe("image/jpeg");
		expect(file.name).toBe("image-img-1.jpg");
		const meta = await sharp(Buffer.from(await file.arrayBuffer())).metadata();
		expect([meta.format, meta.width, meta.height]).toEqual(["jpeg", 32, 16]);
	});

	test("a PNG within the limits is attached unchanged", async () => {
		const bytes = await image("png");
		const { post, uploads } = app(async () => ({ bytes, mime: "image/png" }));
		expect((await post({ requestId, imageId: "img-2" })).status).toBe(201);
		const file = uploads[0]!.file;
		expect([file.type, file.name]).toEqual(["image/png", "image-img-2.png"]);
		expect(Buffer.from(await file.arrayBuffer()).equals(bytes)).toBe(true);
	});

	test("an unreadable library image and invalid input attach nothing", async () => {
		const { post, uploads } = app(async () => {
			throw new Error("larm_http_404");
		});
		const missing = await post({ requestId, imageId: "img-3" });
		expect(missing.status).toBe(502);
		expect(await missing.json()).toEqual({
			error: "image_content_unavailable",
		});
		for (const body of [
			{ requestId: "not-a-uuid", imageId: "img-3" },
			{ requestId, imageId: "../secret" },
			{ requestId, imageId: "img-3", extra: true },
		]) {
			const res = await post(body);
			expect(res.status).toBe(400);
			expect(await res.json()).toMatchObject({
				error: "invalid_attachment_input",
			});
		}
		expect(
			(await post({ requestId, imageId: "img-3" }, "x".repeat(121))).status,
		).toBe(400);
		expect(uploads).toHaveLength(0);
	});
});
