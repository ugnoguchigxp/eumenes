import { expect, test } from "bun:test";
import { createLarmPlayground, ImageImportError } from "..";

const id = "8a0538aa-2649-49dc-b438-abc283374eba";
const imageId = `image_${"a".repeat(32)}`;
const base = {
	requestId: id,
	createdAt: "2026-10-19T00:00:00Z",
	expiresAt: "2026-10-26T00:00:00Z",
	statusUrl: `/v1/image-imports/${id}`,
};
const artifact = {
	id: imageId,
	createdAt: base.createdAt,
	format: "webp",
	mimeType: "image/webp",
	width: 2000,
	height: 1000,
	hasAlpha: true,
	bytes: 100,
	sha256: "a".repeat(64),
	contentUrl: `/v1/image-artifacts/${imageId}/content`,
};
const gateway = (reply: (url: URL, init: RequestInit) => Promise<Response>) =>
	createLarmPlayground({
		baseUrl: "http://127.0.0.1:1234",
		token: "test-control-secret",
		audience: "same-host",
		fetch: ((url, init) => reply(new URL(String(url)), init!)) as typeof fetch,
	});

test("image import sends only one WebP part and the saved UUID using Control authentication", async () => {
	const g = gateway(async (url, init) => {
		expect(url.pathname).toBe("/v1/image-artifacts/imports");
		expect(new Headers(init.headers).get("Authorization")).toBe(
			"Bearer test-control-secret",
		);
		expect(new Headers(init.headers).get("Idempotency-Key")).toBe(id);
		const form = init.body as FormData;
		expect([...form.keys()]).toEqual(["file"]);
		expect((form.get("file") as File).type).toBe("image/webp");
		return Response.json(
			{ ...base, status: "succeeded", deleted: false, artifact },
			{ status: 201 },
		);
	});
	expect(
		(
			await g.imageImports.send(
				id,
				new Uint8Array([1, 2]),
				new AbortController().signal,
			)
		).receipt,
	).toMatchObject({ status: "succeeded", deleted: false, artifact });
});
test("failed receipts and ordinary errors are different; pending honors Retry-After", async () => {
	const signal = new AbortController().signal;
	const failed = gateway(async () =>
		Response.json(
			{
				...base,
				status: "failed",
				error: { code: "invalid_image", message: "bad input" },
			},
			{ status: 400 },
		),
	);
	expect(
		(await failed.imageImports.send(id, new Uint8Array(), signal)).receipt
			.status,
	).toBe("failed");
	const busy = gateway(async () =>
		Response.json(
			{ error: { code: "import_busy", message: "busy" } },
			{ status: 429, headers: { "Retry-After": "2" } },
		),
	);
	await expect(busy.imageImports.read(id, signal)).rejects.toMatchObject({
		status: 429,
		code: "import_busy",
		retryAfterMs: 2000,
	});
	const pending = gateway(async () =>
		Response.json(
			{ ...base, status: "pending" },
			{ status: 202, headers: { "Retry-After": "1" } },
		),
	);
	expect((await pending.imageImports.read(id, signal)).retryAfterMs).toBe(1000);
	expect(new ImageImportError(401, "unauthorized").message).toBe(
		"unauthorized",
	);
});
test("deleted receipt is accepted, but a foreign UUID, path, origin or MIME is never adopted", async () => {
	const signal = new AbortController().signal;
	const deleted = gateway(async () =>
		Response.json({
			...base,
			status: "succeeded",
			deleted: true,
			artifactId: imageId,
		}),
	);
	expect((await deleted.imageImports.read(id, signal)).receipt).toMatchObject({
		deleted: true,
	});
	for (const change of [
		{ requestId: crypto.randomUUID() },
		{ statusUrl: "/v1/image-imports/other" },
		{ artifact: { ...artifact, contentUrl: "https://external.example/image" } },
		{ artifact: { ...artifact, mimeType: "image/png" } },
	]) {
		const g = gateway(async () =>
			Response.json({
				...base,
				status: "succeeded",
				deleted: false,
				artifact,
				...change,
			}),
		);
		await expect(g.imageImports.read(id, signal)).rejects.toThrow();
	}
});
