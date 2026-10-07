import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openStore } from "../../../infrastructure/sqlite";
import {
	migration as conversationMigration,
	createConversationService,
} from "../../conversation";
import { registerContinuity } from "../controller";
import { migration } from "../repository";
import { createContinuityService } from "../service";

const TOKEN = "secret-token";
const ORIGIN = "http://localhost:5173";

async function withApp(
	run: (ctx: {
		app: Hono;
		call: (
			method: string,
			path: string,
			body?: unknown,
		) => Promise<{ status: number; json: any }>;
		append: (
			id: string,
			role: "user" | "assistant",
			text: string,
		) => Promise<number>;
	}) => Promise<void>,
) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-continuity-http-"));
	const store = openStore(join(dir, "db.sqlite3"), [
		conversationMigration,
		migration,
	]);
	try {
		const conversation = createConversationService(store);
		const service = createContinuityService(store, conversation);
		const app = new Hono();
		// Same Bearer + Origin guard as api/application/app.ts
		app.use("/api/*", async (c, next) => {
			const origin = c.req.header("origin");
			if (origin && origin !== ORIGIN)
				return c.json({ error: "origin_forbidden" }, 403);
			if (c.req.header("authorization") !== `Bearer ${TOKEN}`)
				return c.json({ error: "unauthorized" }, 401);
			await next();
		});
		registerContinuity(app, service);
		const call = async (method: string, path: string, body?: unknown) => {
			const response = await app.request(path, {
				method,
				headers: {
					authorization: `Bearer ${TOKEN}`,
					"content-type": "application/json",
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			return { status: response.status, json: await response.json() };
		};
		await run({
			app,
			call,
			append: (id, role, text) =>
				conversation.append({
					id,
					conversationId: "c1",
					role,
					text,
					createdAt: "2026-01-01T00:00:00Z",
					runId: null,
				}),
		});
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

test("create, revise, deactivate, list, history and source over HTTP", async () => {
	await withApp(async ({ call, append }) => {
		await append("m1", "user", "決めたこと");
		const created = await call("POST", "/api/conversations/c1/bookmarks", {
			requestId: "r1",
			sourceMessageId: "m1",
			kind: "decision",
			text: "決めたこと",
		});
		expect(created.status).toBe(201);
		expect(created.json).toMatchObject({
			conversationId: "c1",
			revision: 1,
			origin: "user_confirmed",
		});
		const id = created.json.id as string;

		const revised = await call(
			"POST",
			`/api/conversations/c1/bookmarks/${id}/revise`,
			{ requestId: "r2", expectedRevision: 1, kind: "goal", text: "直した" },
		);
		expect(revised.status).toBe(200);
		expect(revised.json).toMatchObject({ revision: 2, origin: "user_edited" });

		const list = await call("GET", "/api/conversations/c1/bookmarks");
		expect(list.status).toBe(200);
		expect(list.json.stateRevision).toBe(2);
		expect(list.json.bookmarks).toHaveLength(1);

		const history = await call(
			"GET",
			`/api/conversations/c1/bookmarks/${id}/history?limit=1`,
		);
		expect(history.status).toBe(200);
		expect(history.json.events).toHaveLength(1);
		expect(history.json.nextCursor).toBe(history.json.events[0].sequence);
		const next = await call(
			"GET",
			`/api/conversations/c1/bookmarks/${id}/history?after=${history.json.nextCursor}`,
		);
		expect(
			next.json.events.map((e: { revision: number }) => e.revision),
		).toEqual([2]);
		expect(next.json.nextCursor).toBeNull();

		const source = await call(
			"GET",
			`/api/conversations/c1/bookmarks/${id}/source`,
		);
		expect(source.status).toBe(200);
		expect(source.json).toMatchObject({ status: "ok" });
		expect(source.json.message.text).toBe("決めたこと");

		const off = await call(
			"POST",
			`/api/conversations/c1/bookmarks/${id}/deactivate`,
			{ requestId: "r3", expectedRevision: 2 },
		);
		expect(off.status).toBe(200);
		expect(off.json.status).toBe("inactive");
		expect(
			(await call("GET", "/api/conversations/c1/bookmarks")).json.bookmarks,
		).toHaveLength(0);
		expect(
			(
				await call(
					"GET",
					"/api/conversations/c1/bookmarks?includeInactive=true",
				)
			).json.bookmarks,
		).toHaveLength(1);
	});
});

test("maps invalid input to 400, missing to 404, conflicts to 409", async () => {
	await withApp(async ({ app, call, append }) => {
		await append("m1", "user", "t");
		await append("a1", "assistant", "t");
		const valid = {
			requestId: "r1",
			sourceMessageId: "m1",
			kind: "goal",
			text: "t",
		};
		const bad = async (body: unknown) =>
			(await call("POST", "/api/conversations/c1/bookmarks", body)).status;
		expect(await bad({ ...valid, text: "   " })).toBe(400);
		expect(await bad({ ...valid, kind: "other" })).toBe(400);
		expect(await bad({ ...valid, text: "x".repeat(2001) })).toBe(400);
		expect(await bad({})).toBe(400);
		expect(await bad({ ...valid, sourceMessageId: "a1" })).toBe(400);
		const malformed = await app.request("/api/conversations/c1/bookmarks", {
			method: "POST",
			headers: { authorization: `Bearer ${TOKEN}` },
			body: "{not json",
		});
		expect(malformed.status).toBe(400);
		expect(await malformed.json()).toEqual({ error: "invalid_request" });
		expect(
			(
				await call(
					"GET",
					"/api/conversations/c1/bookmarks?includeInactive=maybe",
				)
			).status,
		).toBe(400);

		expect(await bad({ ...valid, sourceMessageId: "nope" })).toBe(404);
		expect(
			(await call("GET", "/api/conversations/c1/bookmarks/missing/source"))
				.status,
		).toBe(404);
		expect(
			(await call("GET", "/api/conversations/c1/bookmarks/missing/history"))
				.status,
		).toBe(404);
		expect(
			(await call("GET", "/api/conversations/c1/bookmarks/x/history?limit=101"))
				.status,
		).toBe(400);

		const created = await call(
			"POST",
			"/api/conversations/c1/bookmarks",
			valid,
		);
		expect(created.status).toBe(201);
		const id = created.json.id as string;
		const conflictBody = {
			requestId: "r1",
			sourceMessageId: "m1",
			kind: "goal",
			text: "different",
		};
		const conflict = await call(
			"POST",
			"/api/conversations/c1/bookmarks",
			conflictBody,
		);
		expect(conflict.status).toBe(409);
		expect(conflict.json).toEqual({ error: "request_conflict" });
		// replay returns the same bookmark with 201
		const replay = await call("POST", "/api/conversations/c1/bookmarks", valid);
		expect(replay.json).toEqual(created.json);

		const stale = await call(
			"POST",
			`/api/conversations/c1/bookmarks/${id}/revise`,
			{ requestId: "r2", expectedRevision: 3, kind: "goal", text: "x" },
		);
		expect(stale.status).toBe(409);
		expect(stale.json).toEqual({ error: "revision_conflict" });
		expect(
			(
				await call("POST", `/api/conversations/c1/bookmarks/${id}/deactivate`, {
					requestId: "r3",
				})
			).status,
		).toBe(400);
		await call("POST", `/api/conversations/c1/bookmarks/${id}/deactivate`, {
			requestId: "r4",
			expectedRevision: 1,
		});
		const inactive = await call(
			"POST",
			`/api/conversations/c1/bookmarks/${id}/revise`,
			{ requestId: "r5", expectedRevision: 2, kind: "goal", text: "x" },
		);
		expect(inactive.status).toBe(409);
		expect(inactive.json).toEqual({ error: "bookmark_inactive" });
		// other conversation cannot touch it
		expect(
			(
				await call("POST", `/api/conversations/c2/bookmarks/${id}/deactivate`, {
					requestId: "r6",
					expectedRevision: 2,
				})
			).status,
		).toBe(404);
	});
});

test("limit exceeded is 400 and concurrent same-revision updates give one 409", async () => {
	await withApp(async ({ call, append }) => {
		await append("m1", "user", "t");
		let firstId = "";
		for (let i = 0; i < 50; i++) {
			const r = await call("POST", "/api/conversations/c1/bookmarks", {
				requestId: `r${i}`,
				sourceMessageId: "m1",
				kind: "goal",
				text: `i${i}`,
			});
			expect(r.status).toBe(201);
			if (i === 0) firstId = r.json.id;
		}
		const over = await call("POST", "/api/conversations/c1/bookmarks", {
			requestId: "over",
			sourceMessageId: "m1",
			kind: "goal",
			text: "over",
		});
		expect(over.status).toBe(400);
		expect(over.json).toEqual({ error: "bookmark_limit_exceeded" });
		const [a, b] = await Promise.all(
			["A", "B"].map((text) =>
				call("POST", `/api/conversations/c1/bookmarks/${firstId}/revise`, {
					requestId: `race-${text}`,
					expectedRevision: 1,
					kind: "goal",
					text,
				}),
			),
		);
		expect([a?.status, b?.status].sort()).toEqual([200, 409]);
	});
});

test("Bearer and Origin guards protect the routes", async () => {
	await withApp(async ({ app }) => {
		const noToken = await app.request("/api/conversations/c1/bookmarks", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				requestId: "r1",
				sourceMessageId: "m1",
				kind: "goal",
				text: "t",
			}),
		});
		expect(noToken.status).toBe(401);
		const wrong = await app.request("/api/conversations/c1/bookmarks", {
			headers: { authorization: "Bearer nope" },
		});
		expect(wrong.status).toBe(401);
		const badOrigin = await app.request("/api/conversations/c1/bookmarks", {
			headers: { authorization: `Bearer ${TOKEN}`, origin: "http://evil.test" },
		});
		expect(badOrigin.status).toBe(403);
		const ok = await app.request("/api/conversations/c1/bookmarks", {
			headers: { authorization: `Bearer ${TOKEN}`, origin: ORIGIN },
		});
		expect(ok.status).toBe(200);
	});
});

test("conversation ids follow the conversation domain", async () => {
	await withApp(async ({ call }) => {
		const ok = await call(
			"GET",
			`/api/conversations/${encodeURIComponent("会話 1")}/bookmarks`,
		);
		expect(ok.status).toBe(200);
	});
});
