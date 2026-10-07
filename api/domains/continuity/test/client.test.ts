import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { continuityClient } from "../../../../client/continuity";
import { ApiError, type Transport } from "../../../../client/transport";
import { openStore } from "../../../infrastructure/sqlite";
import {
	migration as conversationMigration,
	createConversationService,
} from "../../conversation";
import {
	createContinuityService,
	migration,
	projectContinuity,
	registerContinuity,
} from "..";

const token = "test-token";
test("continuity client creates, revises and deactivates through HTTP on a real DB", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-continuity-client-"));
	try {
		const store = openStore(join(dir, "db.sqlite3"), [
			conversationMigration,
			migration,
		]);
		const conversation = createConversationService(store);
		await conversation.append({
			id: "m1",
			conversationId: "c1",
			role: "user",
			text: "来週までに設計を決める",
			createdAt: "2026-01-01T00:00:00Z",
			runId: null,
		});
		const service = createContinuityService(store, conversation);
		const app = new Hono();
		app.use("/api/*", async (c, next) =>
			c.req.header("authorization") === `Bearer ${token}`
				? next()
				: c.json({ error: "unauthorized" }, 401),
		);
		registerContinuity(app, service);
		const transport: Transport = {
			identity: "http://127.0.0.1:0",
			async call(path, init = {}) {
				const response = await app.request(path, {
					...init,
					headers: { Authorization: `Bearer ${token}`, ...init.headers },
				});
				if (!response.ok) {
					const body = (await response.json()) as { error?: string };
					throw new ApiError(response.status, body.error ?? "error");
				}
				return response;
			},
		};
		const client = continuityClient(transport);
		const created = await client.create("c1", {
			requestId: "r1",
			sourceMessageId: "m1",
			kind: "decision",
			text: "設計は来週決める",
		});
		expect(created.revision).toBe(1);
		expect(created.origin).toBe("user_edited");
		const revised = await client.revise("c1", created.id, {
			requestId: "r2",
			expectedRevision: 1,
			kind: "decision",
			text: "設計を来週水曜に決める",
		});
		expect(revised.revision).toBe(2);
		const list = await client.list("c1", {});
		expect(list.bookmarks.map((b) => b.text)).toEqual([
			"設計を来週水曜に決める",
		]);
		const projection = projectContinuity(service.getSnapshot("c1"), 10_000);
		expect(projection.status).toBe("ready");
		const stale = await client
			.revise("c1", created.id, {
				requestId: "r3",
				expectedRevision: 1,
				kind: "goal",
				text: "x",
			})
			.catch((e) => e);
		expect(stale).toBeInstanceOf(ApiError);
		expect((stale as ApiError).status).toBe(409);
		await client.deactivate("c1", created.id, {
			requestId: "r4",
			expectedRevision: 2,
		});
		expect((await client.list("c1", {})).bookmarks).toEqual([]);
		expect(
			(await client.list("c1", { includeInactive: true })).bookmarks[0]?.status,
		).toBe("inactive");
		const history = await client.history("c1", created.id, {});
		expect(history.events.map((e) => e.operation)).toEqual([
			"create",
			"revise",
			"deactivate",
		]);
		expect((await client.source("c1", created.id)).status).toBe("ok");
		expect(projectContinuity(service.getSnapshot("c1"), 10_000)).toMatchObject({
			status: "ready",
			items: [],
		});
		await store.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
