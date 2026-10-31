import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { answerError } from "../../../application/app";
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
	a.onError(answerError);
	registerBrowser(a, env.service, owner);
	return a;
}

test("the setting is read and saved over HTTP, and a relative path is refused", async () => {
	const env = setup({ standardPaths: [] });
	const path = fakeBrave(env.dir);
	const a = app(env);
	expect(await (await a.request("/api/browser/setting")).json()).toEqual({
		executablePath: null,
		suggestedPath: null,
		canBrowse: false,
	});
	expect(
		(await a.request("/api/browser/setting/browse", { method: "POST" })).status,
	).toBe(501);
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
		suggestedPath: null,
		canBrowse: false,
	});
});

test("the open tabs are readable", async () => {
	const env = setup({ runTaskStep: parkedRunner });
	const a = app(env);
	const tabRef = await connect(env);
	const tabs = (await (await a.request("/api/browser/tabs")).json()) as {
		tabs: { tabRef: string }[];
	};
	expect(tabs.tabs.map((t) => t.tabRef)).toEqual([tabRef]);
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
});

test("a conversation keeps its own recent tasks even after more than twenty tasks in other chats", async () => {
	const env = setup({
		runTaskStep: async () => ({
			kind: "done",
			state: "completed",
			coreState: null,
			text: "確認済み",
		}),
	});
	const tabRef = await connect(env);
	const make = async (conversationId: string, owner = OWNER) => {
		const t = await env.service.startTask({
			owner,
			conversationId,
			origin: "screen",
			requestId: crypto.randomUUID(),
			request: "表示確認",
			tabRef,
		});
		await until(() => env.service.taskRow(t.taskId)?.state === "completed");
		return t;
	};
	const own = await make("current-chat");
	for (let i = 0; i < 21; i++) await make("another-chat");
	await make("current-chat", "different-owner");
	const response = await app(env).request(
		"/api/browser/tasks?conversationId=current-chat",
	);
	expect(response.status).toBe(200);
	expect(response.headers.get("Cache-Control")).toBe("no-store");
	const body = await response.json();
	expect(body.tasks.map((t: { taskId: string }) => t.taskId)).toEqual([
		own.taskId,
	]);
	expect((await app(env).request("/api/browser/tasks")).status).toBe(400);
});
