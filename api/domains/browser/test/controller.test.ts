import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { registerBrowser } from "..";
import {
	OWNER,
	connect,
	fakeBrave,
	parkedRunner,
	runCleanup,
	setup,
	until,
} from "./fakes";

afterEach(runCleanup);

function app(env: ReturnType<typeof setup>, owner = OWNER) {
	const a = new Hono();
	registerBrowser(a, env.service, owner);
	return a;
}

test("the setting is read and saved over HTTP, and a relative path is refused", async () => {
	const env = setup();
	const path = fakeBrave(env.dir);
	const a = app(env);
	expect(await (await a.request("/api/browser/setting")).json()).toEqual({
		executablePath: null,
	});
	const put = (body: unknown) =>
		a.request("/api/browser/setting", {
			method: "PUT",
			body: JSON.stringify(body),
			headers: { "content-type": "application/json" },
		});
	expect((await put({ executablePath: "brave" })).status).toBe(400);
	expect((await put({ executablePath: path, extra: 1 })).status).toBe(400);
	expect((await put({ executablePath: `${path}-missing` })).status).toBe(400);
	expect(await (await put({ executablePath: path })).json()).toEqual({
		executablePath: path,
	});
	expect(await (await a.request("/api/browser/setting")).json()).toEqual({
		executablePath: path,
	});
});

test("connection, tabs, tasks and captures are readable and never cached", async () => {
	const env = setup({ runTaskStep: parkedRunner });
	const a = app(env);
	const tabRef = await connect(env);
	const conn = await a.request("/api/browser/connection");
	expect(conn.headers.get("Cache-Control")).toBe("no-store");
	expect(await conn.json()).toMatchObject({
		state: "connected",
		availability: { available: true },
	});
	const tabs = (await (await a.request("/api/browser/tabs")).json()) as {
		tabs: { tabRef: string }[];
	};
	expect(tabs.tabs.map((t) => t.tabRef)).toEqual([tabRef]);
	const task = await env.service.startTask({
		owner: OWNER,
		conversationId: "main",
		origin: "screen",
		requestId: crypto.randomUUID(),
		request: "open it",
		tabRef,
	});
	const status = await a.request(`/api/browser/tasks/${task.taskId}`);
	expect(await status.json()).toMatchObject({
		taskId: task.taskId,
		operations: [],
	});
	expect((await a.request("/api/browser/tasks/not-an-id")).status).toBe(400);
	expect(
		(await a.request(`/api/browser/tasks/${crypto.randomUUID()}`)).status,
	).toBe(404);
	expect(
		(await app(env, "other").request(`/api/browser/tasks/${task.taskId}`))
			.status,
	).toBe(404);
	expect(await (await a.request("/api/browser/captures")).json()).toEqual({
		captures: [],
	});
});

test("capture content is served only to its owner, as an inline lossy WebP", async () => {
	const env = setup();
	const a = app(env);
	const tabRef = await connect(env);
	const c = await env.service.startCapture({
		requestId: crypto.randomUUID(),
		owner: OWNER,
		conversationId: "main",
		origin: "screen",
		tabRef,
		range: "viewport",
	});
	await until(
		() => env.service.captureStatus(OWNER, c.captureId).state === "local_ready",
	);
	const res = await a.request(`/api/browser/captures/${c.captureId}/content`);
	expect(res.status).toBe(200);
	expect(res.headers.get("Content-Type")).toBe("image/webp");
	expect(res.headers.get("Cache-Control")).toBe("no-store");
	expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
	expect(res.headers.get("Content-Disposition")).toBe(
		`inline; filename="capture-${c.captureId}.webp"`,
	);
	expect((await res.arrayBuffer()).byteLength).toBe(10);
	expect(
		(
			await app(env, "other").request(
				`/api/browser/captures/${c.captureId}/content`,
			)
		).status,
	).toBe(404);
	expect((await a.request("/api/browser/captures/..%2Fx/content")).status).toBe(
		400,
	);
	const list = (await (await a.request("/api/browser/captures")).json()) as {
		captures: unknown[];
	};
	expect(list.captures).toHaveLength(1);
});
