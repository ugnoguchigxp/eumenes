import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { openStore } from "../../../infrastructure/sqlite";
import { migrations, createConversationService } from "..";
import { normalizeImage } from "../service/normalize-image";

import { syntheticImages } from "./image.fixture";
test("JPG PNG BMP fully decode; normalized pixels, alpha and EXIF match previews", async () => {
	for (const f of await syntheticImages()) {
		const v = await normalizeImage(
			new Uint8Array(await f.arrayBuffer()),
			f.type,
		);
		expect(String(v.mime)).toBe(f.type);
		expect(v.width).toBe(24);
		expect(v.height).toBe(18);
		const pixel = await sharp(v.preview).raw().toBuffer();
		expect(pixel[0]).toBeGreaterThan(200);
		expect(pixel[1]).toBeLessThan(60);
	}
	const rotated = await sharp({
		create: { width: 30, height: 20, channels: 3, background: "red" },
	})
		.jpeg()
		.withMetadata({ orientation: 6 })
		.toBuffer();
	const v = await normalizeImage(rotated, "image/jpeg");
	expect([v.width, v.height]).toEqual([20, 30]);
	const alpha = await sharp({
		create: {
			width: 2,
			height: 2,
			channels: 4,
			background: { r: 255, g: 0, b: 0, alpha: 0 },
		},
	})
		.png()
		.toBuffer();
	const flat = await normalizeImage(alpha, "image/png");
	expect(
		[...(await sharp(flat.bytes).raw().toBuffer())].every((x) => x === 255),
	).toBe(true);
});
test("rejects broken and mismatched images and predecode dimensions", async () => {
	const png = (await syntheticImages())[1]!;
	const bytes = new Uint8Array(await png.arrayBuffer());
	await expect(normalizeImage(bytes, "image/jpeg")).rejects.toThrow(
		"image_mime_mismatch",
	);
	await expect(
		normalizeImage(bytes.subarray(0, 25), "image/png"),
	).rejects.toThrow("image_invalid");
	await expect(
		normalizeImage(new Uint8Array(3145729), "image/png"),
	).rejects.toThrow("image_too_large");
	const huge = Buffer.from(await (await syntheticImages())[2]!.arrayBuffer());
	huge.writeInt32LE(999999, 18);
	await expect(normalizeImage(huge, "image/bmp")).rejects.toThrow(
		"image_dimensions_exceeded",
	);
});
test("attachment owner, conversation, replay identity and restart persistence", async () => {
	const dir = mkdtempSync(join(tmpdir(), "image-attachment-"));
	const path = join(dir, "db");
	let store = openStore(path, migrations);
	try {
		let c = createConversationService(store, { principal: "owner-a" });
		const f = (await syntheticImages())[1]!;
		const id = crypto.randomUUID();
		const a = await c.uploadAttachment("main", id, f);
		expect(await c.uploadAttachment("main", id, f)).toEqual(a);
		expect(() => c.attachmentContent("other", id)).toThrow(
			"attachment_not_found",
		);
		expect(() =>
			createConversationService(store, {
				principal: "owner-b",
			}).attachmentContent("main", id),
		).toThrow("attachment_not_found");
		await expect(
			c.uploadAttachment("main", id, (await syntheticImages())[0]!),
		).rejects.toThrow("request_conflict");
		await c.append({
			id: "image-message",
			role: "user",
			conversationId: "main",
			text: "",
			attachments: [a],
			createdAt: new Date().toISOString(),
			runId: null,
		});
		await store.close();
		store = openStore(path, migrations);
		c = createConversationService(store, { principal: "owner-a" });
		expect(c.get("main").messages[0]!.attachments).toEqual([a]);
		expect(c.attachmentContent("main", id).bytes.length).toBe(a.size);
		await c.retract({ messageId: "image-message" });
		expect(() => c.attachmentContent("main", id)).toThrow(
			"attachment_source_unavailable",
		);
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
