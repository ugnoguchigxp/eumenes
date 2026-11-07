import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { fileMime, registerScratch } from "../controller";
import { createScratchStore } from "../service/store";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function app() {
	const root = mkdtempSync(join(tmpdir(), "scratch-http-"));
	roots.push(root);
	const store = createScratchStore({ root, freeBytes: () => null });
	const hono = new Hono();
	registerScratch(hono, store);
	return { hono, store };
}
const requestId = "22222222-2222-4222-8222-222222222222";
/** A real Request, so the multipart body carries its Content-Type like a browser's. */
const upload = (form: FormData) =>
	new Request(
		`http://localhost/api/conversations/main/scratch?requestId=${requestId}`,
		{ method: "POST", body: form },
	);

test("uploads a user file and serves it with safe headers", async () => {
	const { hono } = app();
	const form = new FormData();
	form.append("file", new File(["# 見出し"], "仕様.md", { type: "" }));
	const created = await hono.request(upload(form));
	expect(created.status).toBe(201);
	const item = (await created.json()) as { id: string; uri: string; mime: string; maker: string; origin: string; contentUrl: string };
	expect(item).toMatchObject({
		id: requestId,
		uri: `eumenes://scratch/${requestId}`,
		mime: "text/markdown",
		maker: "利用者",
		origin: "attached",
	});
	const content = await hono.request(item.contentUrl);
	expect(content.status).toBe(200);
	expect(content.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
	expect(content.headers.get("X-Content-Type-Options")).toBe("nosniff");
	expect(content.headers.get("Content-Disposition")).toStartWith("inline;");
	expect(await content.text()).toBe("# 見出し");
	const meta = await hono.request(`/api/scratch/${requestId}`);
	expect(((await meta.json()) as { name: string }).name).toBe("仕様.md");
});

test("a PDF downloads as an attachment; unknown ids and types are refused", async () => {
	const { hono, store } = app();
	const item = await store.put({
		conversationId: "main",
		name: "資料.pdf",
		mime: "application/pdf",
		data: new Uint8Array([37, 80, 68, 70]),
		origin: "attached",
		maker: "利用者",
	});
	const content = await hono.request(`/api/scratch/${item.id}/content`);
	expect(content.headers.get("Content-Disposition")).toStartWith("attachment;");
	expect((await hono.request("/api/scratch/not-a-uuid")).status).toBe(404);
	expect(
		(await hono.request(`/api/scratch/${requestId}/content`)).status,
	).toBe(404);
	const form = new FormData();
	form.append("file", new File(["<svg/>"], "x.svg", { type: "image/svg+xml" }));
	const refused = await hono.request(upload(form));
	expect(refused.status).toBe(415);
});

test("the type comes from the browser when known, else from the extension", () => {
	expect(fileMime({ name: "a.bin", type: "application/json" })).toBe("application/json");
	expect(fileMime({ name: "model.GLB", type: "application/octet-stream" })).toBe("model/gltf-binary");
	expect(fileMime({ name: "page.html", type: "text/html" })).toBeNull();
});
