import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { Attachment } from "../../domains/conversation/contracts/attachments";
import type { LarmPlayground } from "../../domains/larm";
import { createScratchStore } from "../../domains/scratch";
import {
	attachmentSharing,
	PASTE_CHARS,
	sharedFiles,
	sharedWrites,
} from "./scratch-composition";
import { sharedImageImports } from "./shared-image-import";

/** The application's parts of the shared files (spec/server-scratch-cache-design-2026-11-07.md §3・§9.1・§11.1). */
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function store() {
	const root = mkdtempSync(join(tmpdir(), "scratch-app-"));
	roots.push(root);
	return createScratchStore({ root, freeBytes: () => null });
}
const png = (width: number, height: number) =>
	sharp({ create: { width, height, channels: 3, background: "#3a8" } })
		.png()
		.toBuffer()
		.then((b) => new Uint8Array(b));
const attachment = (over: Partial<Attachment> = {}): Attachment => ({
	id: "11111111-1111-4111-8111-111111111111",
	conversationId: "main",
	name: "IMG_2041.png",
	mime: "image/png",
	originalMime: "image/png",
	width: 8,
	height: 4,
	size: 10,
	digest: "d",
	createdAt: "2026-11-07T05:02:11.000Z",
	...over,
});

test("an attachment is shared under its own id as the image the user sent; a BMP as the image the model reads", async () => {
	const s = store();
	const original = await png(16, 8);
	await attachmentSharing(s)(attachment(), { original, normalized: await png(8, 4) });
	const item = s.get("11111111-1111-4111-8111-111111111111")!;
	expect(item).toMatchObject({
		name: "IMG_2041.png",
		mime: "image/png",
		origin: "attached",
		maker: "利用者",
		width: 16,
		height: 8,
	});
	const bmpId = "22222222-2222-4222-8222-222222222222";
	await attachmentSharing(s)(
		attachment({ id: bmpId, originalMime: "image/bmp", name: "scan.bmp" }),
		{ original: new Uint8Array([66, 77]), normalized: await png(8, 4) },
	);
	expect(s.get(bmpId)).toMatchObject({ mime: "image/png", width: 8, height: 4 });
});

test("an input's attachments are shared; a long text also becomes a file under the request's id", async () => {
	const s = store();
	const port = sharedFiles(s, () => Date.parse("2026-11-07T04:58:00.000Z"));
	await attachmentSharing(s)(attachment(), {
		original: await png(4, 4),
		normalized: await png(4, 4),
	});
	const requestId = "33333333-3333-4333-8333-333333333333";
	const short = await port.inputUris({
		requestId,
		conversationId: "main",
		text: "これを見て",
		attachmentIds: ["11111111-1111-4111-8111-111111111111", "44444444-4444-4444-8444-444444444444"],
		fileIds: [],
	});
	// The attachment the store does not have (never uploaded here) is left out.
	expect(short).toEqual(["eumenes://scratch/11111111-1111-4111-8111-111111111111"]);
	const text = "仕様".repeat(PASTE_CHARS);
	const long = await port.inputUris({ requestId, conversationId: "main", text, attachmentIds: [], fileIds: [] });
	expect(long).toEqual([`eumenes://scratch/${requestId}`]);
	expect(s.get(requestId)).toMatchObject({
		name: "貼り付けた文章 13:58",
		mime: "text/plain",
		origin: "pasted",
	});
	// A resent request finds the same file.
	expect(
		await port.inputUris({ requestId, conversationId: "main", text, attachmentIds: [], fileIds: [] }),
	).toEqual(long);
	expect(port.recentUris("main", 1)).toEqual([`eumenes://scratch/${requestId}`]);
	// A file the user uploaded is taken; an agent's write named as the user's file is not.
	const fileId = "77777777-7777-4777-8777-777777777777";
	await s.put({ id: fileId, conversationId: "main", name: "仕様.md", mime: "text/markdown", data: new Uint8Array([35]), origin: "attached", maker: "利用者" });
	const written = await s.put({ conversationId: "main", name: "下書き.md", mime: "text/markdown", data: new Uint8Array([36]), origin: "written", maker: "Web調査" });
	expect(
		await port.inputUris({ requestId: crypto.randomUUID(), conversationId: "main", text: "", attachmentIds: [], fileIds: [fileId, written.id] }),
	).toEqual([`eumenes://scratch/${fileId}`]);
});

test("a sub-agent's write is the conversation's file made by its title; an oversized one is refused", async () => {
	const s = store();
	const port = sharedWrites(s);
	const done = await port.write(
		{ name: "価格表.md", mime: "text/markdown", text: "| 社名 | 月額 |" },
		{ conversationId: "main", maker: "詳しいWeb調査" },
		AbortSignal.timeout(1000),
	);
	expect(done.ok).toBe(true);
	const id = (done as { uri: string }).uri.replace("eumenes://scratch/", "");
	expect(s.get(id)).toMatchObject({ origin: "written", maker: "詳しいWeb調査" });
	expect(
		await port.write(
			{ name: "大きい.txt", mime: "text/plain", text: "あ".repeat(400_000) },
			{ conversationId: "main", maker: "x" },
			AbortSignal.timeout(1000),
		),
	).toEqual({ ok: false, code: "scratch_too_large" });
});

test("a held shared image is saved once into the LARM library and its artifact returned", async () => {
	const s = store();
	const item = await s.put({
		conversationId: "main",
		name: "IMG.png",
		mime: "image/png",
		data: await png(40, 20),
		origin: "attached",
		maker: "利用者",
	});
	const sent: Array<{ key: string; bytes: number }> = [];
	let reads = 0;
	const receipt = (status: "pending" | "succeeded") =>
		status === "pending"
			? { receipt: { status }, retryAfterMs: 1, httpStatus: 202 }
			: {
					receipt: { status, deleted: false, artifact: { id: "lib-art-1" } },
					retryAfterMs: 1,
					httpStatus: 200,
				};
	const client = {
		identity: "larm",
		send: async (key: string, bytes: Uint8Array) => {
			sent.push({ key, bytes: bytes.length });
			return receipt("pending");
		},
		read: async () => (++reads < 2 ? receipt("pending") : receipt("succeeded")),
	} as unknown as LarmPlayground["imageImports"];
	const imports = sharedImageImports(s, () => client);
	const key = "55555555-5555-4555-8555-555555555555";
	imports.hold(item.id, key);
	expect(await imports.artifact(item.id, key, AbortSignal.timeout(3000))).toBe("lib-art-1");
	expect(sent).toHaveLength(1);
	expect(sent[0]!.key).toBe(key);
	imports.release(key);
	expect(() => imports.hold("66666666-6666-4666-8666-666666666666", key)).toThrow(
		"model3d_image_not_found",
	);
	const failing = sharedImageImports(s, () => ({
		...client,
		send: async () => {
			throw new Error("image_import_refused");
		},
	}) as never);
	await expect(failing.artifact(item.id, key, AbortSignal.timeout(1000))).rejects.toThrow(
		"model3d_source_import_failed",
	);
	expect(sharedImageImports(s, () => null).artifact(item.id, key, AbortSignal.timeout(1000))).rejects.toThrow(
		"model3d_larm_unconfigured",
	);
});
