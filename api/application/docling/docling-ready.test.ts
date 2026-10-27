import { expect, test } from "bun:test";
import { createApp } from "../app";
import { createDocling, registerDocling } from "../../domains/docling";

test("startup API enforces authentication and Origin, waits once, and returns no ticket", async () => {
	let posts = 0;
	const response = Promise.withResolvers<Response>();
	const status = {
		revision: 1,
		configured: true,
		publicOrigin: "http://localhost:28765",
	};
	const docling = createDocling({
		connection: () => ({
			...status,
			version: "v1",
			gatewayUrl: "http://127.0.0.1:28765",
			credential: "fixture-secret",
		}),
		status: () => status,
		fetch: async () => {
			posts++;
			return response.promise;
		},
	});
	const app = createApp({
		token: "fixture-api",
		origin: "http://127.0.0.1:5173",
		modules: [{ mount: (hono) => registerDocling(hono, docling) }],
	});
	const path = "/api/docling/ready";
	const headers = { Authorization: "Bearer fixture-api" };
	expect((await app.request(path, { method: "POST" })).status).toBe(401);
	expect(
		(
			await app.request(path, {
				method: "POST",
				headers: { ...headers, Origin: "http://other.invalid" },
			})
		).status,
	).toBe(403);
	expect(posts).toBe(0);
	let timeout = 0;
	const pending = app.request(
		path,
		{ method: "POST", headers },
		{
			timeout: (_request: Request, seconds: number) => {
				timeout = seconds;
			},
		},
	);
	await Bun.sleep(0);
	expect(posts).toBe(1);
	expect((await app.request(path, { method: "POST", headers })).status).toBe(
		409,
	);
	response.resolve(
		Response.json({
			url: `/auth/exchange?ticket=${"f".repeat(43)}`,
			expires_in: 60,
		}),
	);
	const ready = await pending;
	expect(ready.status).toBe(200);
	expect(ready.headers.get("cache-control")).toBe("no-store");
	expect(timeout).toBe(200);
	expect(await ready.json()).toEqual(status);
	expect(posts).toBe(1);
});
