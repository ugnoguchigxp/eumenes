import { expect, test } from "bun:test";
import { createApp } from "../app";
import { registerImageImports } from "../../domains/image/controller/imports";
import type { ImageImportView } from "../../domains/image/contracts";
test("the authenticated application streams image multipart over 1 MiB through the upload route's own cap", async () => {
	const id = crypto.randomUUID();
	let size = 0;
	const view: ImageImportView = {
		requestId: id,
		status: "ready",
		createdAt: 1,
		expiresAt: 2,
		retryAfterMs: 1000,
	};
	const app = createApp({
		token: "fixture-token",
		origin: "http://localhost",
		modules: [
			{
				mount: (app) =>
					registerImageImports(app, {
						imports: {
							async upload(_id, file) {
								size = file.size;
								return view;
							},
							async read() {
								return view;
							},
							async resume() {
								return view;
							},
						},
					}),
			},
		],
	});
	const form = new FormData();
	form.append(
		"file",
		new File([new Uint8Array(2 * 1024 * 1024)], "photo.png", {
			type: "image/png",
		}),
	);
	const content = new Response(form);
	const type = content.headers.get("Content-Type")!;
	const bytes = await content.arrayBuffer();
	const headers = {
		"Content-Type": type,
		"Content-Length": String(bytes.byteLength),
		Authorization: "Bearer fixture-token",
	};
	const first = await app.request(`/api/images/imports?requestId=${id}`, {
		method: "POST",
		body: bytes,
		headers,
	});
	expect({ status: first.status, body: await first.json() }).toMatchObject({
		status: 200,
		body: view,
	});

	expect(size).toBe(2 * 1024 * 1024);
	expect(
		(
			await app.request("/api/images/imports-extra", {
				method: "POST",
				body: bytes,
				headers,
			})
		).status,
	).toBe(413);
	expect(
		(
			await app.request(`/api/images/imports?requestId=${id}`, {
				method: "POST",
				body: bytes,
				headers: { ...headers, Authorization: "Bearer wrong" },
			})
		).status,
	).toBe(401);
	const oversized = new Uint8Array(16 * 1024 * 1024 + 65537);
	expect(
		(
			await app.request(`/api/images/imports?requestId=${id}`, {
				method: "POST",
				body: oversized,
				headers: { ...headers, "Content-Length": String(oversized.byteLength) },
			})
		).status,
	).toBe(413);
});
