import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openStore } from "../../../infrastructure/sqlite";
import {
	createResearchRoutes,
	createOperations,
	registerResearchRoutes,
	ledger,
	migration,
	ttl,
} from "..";

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of open.splice(0)) await close();
});
async function setup() {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-stored-routes-"));
	const store = openStore(join(dir, "db"), [migration]);
	open.push(async () => {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	let now = 1000000;
	const clock = { now: () => now, id: () => crypto.randomUUID() };
	const routes = createResearchRoutes({ clock });
	const changes: unknown[] = [];
	const ops = createOperations({
		store,
		routes,
		clock,
		onChange: (updates) => changes.push(...updates),
		skills: () => ({ hash: "a".repeat(64), body: "A stored procedure" }),
	});
	const key = "a".repeat(64);
	await store.write((db) => {
		ledger.insertKey(db, {
			epoch: 0,
			key,
			incarnation: "legacy",
			specJson: JSON.stringify({
				keyVersion: 1,
				scope: "local:owner",
				language: "ja",
				region: "JP",
				timeZone: "Asia/Tokyo",
				keywords: "保存済みの依頼",
				purpose: "weather",
				target: {
					name: "任意の地域",
					prefecture: "任意の県",
					granularity: "city",
				},
				requiredFields: ["condition"],
				timeMode: "today",
			}),
			keywords: "保存済みの依頼",
			now,
		});
		ledger.insertRevision(db, {
			version_id: "v1",
			epoch: 0,
			key,
			incarnation: "legacy",
			revision: 1,
			recipe_json: JSON.stringify({
				toolId: "web.read",
				arguments: { url: "https://example.com/source" },
				sourceUrl: "https://example.com/source",
				specDigest: key,
				validationProfile: "weather-excerpt-v1",
				singleSource: true,
			}),
			context_projection: "Stored context",
			skill_revision_id: "old-skill",
			package_revision_id: "old-package",
			proof_digest: "a".repeat(64),
			review_digest: "b".repeat(64),
			registration_certificate_json: "{}",
			validation_policy_version: 1,
			created_at: now,
			revalidate_at: now + ttl.absoluteMs,
		});
		db.query(
			"UPDATE research_route_keys SET active_version_id=? WHERE key=?",
		).run("v1", key);
	});
	const detail = () =>
		ops.show(key).body as {
			state: string;
			stateToken: string;
			skillRevision: { body: string } | null;
			contextProjection: string | null;
		};
	return {
		store,
		routes,
		ops,
		key,
		detail,
		changes,
		advance: (ms: number) => (now += ms),
	};
}

test("stored procedures remain readable but editing cannot schedule retired learning jobs", async () => {
	const h = await setup();
	expect(h.detail().skillRevision?.body).toBe("A stored procedure");
	expect(h.detail().contextProjection).toBe("Stored context");
	expect(
		await h.ops.edit(h.key, {
			requestId: crypto.randomUUID(),
			expectedStateToken: h.detail().stateToken,
			instruction: "新しい対象と説明",
		}),
	).toMatchObject({ status: 409, body: { error: "route_not_editable" } });
	expect(
		h.store.read((db) =>
			db.query("SELECT COUNT(*) n FROM research_route_drafts").get(),
		),
	).toEqual({ n: 0 });
});

test("disable and release retain token checks and idempotent receipts", async () => {
	const h = await setup();
	const initial = h.detail().stateToken;
	const input = { requestId: crypto.randomUUID(), expectedStateToken: initial };
	const disabled = await h.ops.disable(h.key, input);
	expect(disabled.status).toBe(200);
	expect(h.detail().state).toBe("disabled");
	expect(await h.ops.disable(h.key, input)).toEqual(disabled);
	expect(h.changes).toHaveLength(1);
	expect(
		await h.ops.rediscover(h.key, {
			requestId: crypto.randomUUID(),
			expectedStateToken: initial,
		}),
	).toMatchObject({ status: 409 });
	expect(
		await h.ops.rediscover(h.key, {
			requestId: crypto.randomUUID(),
			expectedStateToken: h.detail().stateToken,
		}),
	).toMatchObject({ status: 200 });
	expect(h.detail().state).toBe("unregistered");
});

test("clear invalidates paged cursors and details before physical reclaim", async () => {
	const h = await setup();
	await h.store.write((db) =>
		ledger.insertKey(db, {
			epoch: 0,
			key: "b".repeat(64),
			incarnation: "other",
			specJson: "{}",
			keywords: "Other",
			now: 1000000,
		}),
	);
	const list = h.ops.list({ limit: 1 }).body as {
		nextCursor: string;
		epoch: number;
	};
	expect(list.nextCursor).toBeTruthy();
	const request = { requestId: crypto.randomUUID(), expectedEpoch: list.epoch };
	const cleared = await h.ops.clear(request);
	expect(cleared.body).toEqual({ epoch: 1, deletedKeys: 2 });
	expect(await h.ops.clear(request)).toEqual(cleared);
	expect(h.ops.show(h.key).status).toBe(404);
	expect(h.ops.list({ cursor: list.nextCursor }).status).toBe(409);
	await h.store.write((db) =>
		h.routes.sweepInTransaction(db, { mode: "epoch" }),
	);
	expect(
		h.store.read((db) =>
			db.query("SELECT COUNT(*) n FROM research_route_keys").get(),
		),
	).toEqual({ n: 0 });
});

test("idle cleanup preserves disabled records and reclaims enabled legacy data", async () => {
	const h = await setup();
	await h.store.write((db) =>
		ledger.insertKey(db, {
			epoch: 0,
			key: "b".repeat(64),
			incarnation: "other",
			specJson: "{}",
			keywords: "Other",
			now: 1000000,
		}),
	);
	await h.ops.disable(h.key, {
		requestId: crypto.randomUUID(),
		expectedStateToken: h.detail().stateToken,
	});
	h.advance(ttl.idleMs + 1);
	await h.store.write((db) => h.routes.sweepInTransaction(db));
	expect(h.ops.show(h.key).status).toBe(200);
	expect(h.ops.show("b".repeat(64)).status).toBe(404);
});

test("management authentication runs before request parsing and stale writes fail", async () => {
	const h = await setup();
	const app = new Hono();
	app.use("/api/*", async (c, next) =>
		c.req.header("authorization") === "Bearer fixture"
			? next()
			: c.json({ error: "unauthorized" }, 401),
	);
	registerResearchRoutes(app, h.ops);
	expect(
		(
			await app.request("/api/research-routes/clear", {
				method: "POST",
				body: "malformed",
			})
		).status,
	).toBe(401);
	const response = await app.request(`/api/research-routes/${h.key}/disable`, {
		method: "POST",
		headers: {
			authorization: "Bearer fixture",
			"content-type": "application/json",
		},
		body: JSON.stringify({
			requestId: crypto.randomUUID(),
			expectedStateToken: "0".repeat(64),
		}),
	});
	expect(response.status).toBe(409);
	expect(h.detail().state).toBe("active");
});
