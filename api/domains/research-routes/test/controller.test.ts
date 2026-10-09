import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { ledger, ttl, registerResearchRoutes, createOperations } from "..";
import { type Env, activateRoute, setup, NOW } from "./support";
import { bindRequest, buildSearchSpec, specKey } from "..";

const envs: Env[] = [];
afterEach(async () => {
	for (const e of envs.splice(0)) await e.close();
});
const mk = async () => {
	const e = await setup();
	envs.push(e);
	return e;
};
let seq = 0;
const rid = () => `11111111-1111-4111-8111-${String(++seq).padStart(12, "0")}`;

function api(env: Env, opts: { changes?: unknown[] } = {}) {
	const ops = createOperations({
		routes: env.routes,
		store: env.store,
		clock: env.clock,
		skills: (_db, id) => ({ hash: "h".repeat(64), body: `body of ${id}` }),
		onChange: (c) => opts.changes?.push(...c),
	});
	const app = new Hono();
	// Stand-in for the application's auth middleware: it must run before every handler.
	app.use("/api/*", async (c, next) =>
		c.req.header("authorization") === "Bearer t"
			? next()
			: c.json({ error: "unauthorized" }, 401),
	);
	registerResearchRoutes(app, ops);
	const call = async (method: string, path: string, body?: unknown) => {
		const res = await app.request(path, {
			method,
			headers: {
				authorization: "Bearer t",
				"content-type": "application/json",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		return { status: res.status, body: (await res.json()) as any };
	};
	return { app, call };
}
const newKey = (env: Env, q: string) =>
	env.store.write((db) => {
		const r = buildSearchSpec(q);
		if (r.kind !== "matched") throw new Error(q);
		env.routes.lookupInTransaction(
			db,
			r.spec,
			bindRequest(r.spec, env.clock.now()),
		);
		return specKey(r.spec);
	});

test("H01 auth runs first; list/show DTOs, strict input and unknown keys", async () => {
	const env = await mk();
	const { app, call } = api(env);
	const unauth = await app.request("/api/research-routes", { method: "GET" });
	expect(unauth.status).toBe(401);
	const unauthPost = await app.request("/api/research-routes/clear", {
		method: "POST",
		body: "{}",
	});
	expect(unauthPost.status).toBe(401);
	const c = await activateRoute(env);
	const list = await call("GET", "/api/research-routes");
	expect(list.status).toBe(200);
	expect(list.body.epoch).toBe(0);
	expect(list.body.items).toHaveLength(1);
	const item = list.body.items[0];
	expect(item.state).toBe("active");
	expect(item.key).toBe(c.key);
	expect(item.stateToken).toMatch(/^[0-9a-f]{64}$/);
	expect(item.skillRevision).toBeUndefined();
	expect(item.contextProjection).toBeUndefined();
	expect(item.draftStatus).toMatchObject({ state: "activated" });
	const show = await call("GET", `/api/research-routes/${c.key}`);
	expect(show.status).toBe(200);
	expect(show.body.skillRevision.body).toContain("body of");
	expect(typeof show.body.contextProjection).toBe("string");
	expect(
		(await call("GET", `/api/research-routes/${"a".repeat(64)}`)).status,
	).toBe(404);
	expect((await call("GET", "/api/research-routes/zz")).status).toBe(400);
	expect((await call("GET", "/api/research-routes?limit=0")).status).toBe(400);
	expect((await call("GET", "/api/research-routes?foo=1")).status).toBe(400);
	const bad = await call("POST", `/api/research-routes/${c.key}/disable`, {
		requestId: rid(),
		expectedStateToken: item.stateToken,
		extra: 1,
	});
	expect(bad.status).toBe(400);
});

test("H01 expired route is 200 with null bodies; cursor paging key ASC; stale cursor 409", async () => {
	const env = await mk();
	const { call } = api(env);
	const c = await activateRoute(env);
	env.advance(ttl.absoluteMs + 1000);
	const show = await call("GET", `/api/research-routes/${c.key}`);
	expect(show.status).toBe(200);
	expect(show.body.state).toBe("expired");
	expect(show.body.skillRevision).toBeNull();
	expect(show.body.contextProjection).toBeNull();
	const a = await newKey(env, "株価 AAPL");
	const b = await newKey(env, "天気予報 静岡市");
	const keys = [c.key, a, b].sort();
	const p1 = await call("GET", "/api/research-routes?limit=2");
	expect(p1.body.items.map((i: any) => i.key)).toEqual(keys.slice(0, 2));
	expect(p1.body.nextCursor).toBeTruthy();
	const p2 = await call(
		"GET",
		`/api/research-routes?limit=2&cursor=${p1.body.nextCursor}`,
	);
	expect(p2.body.items.map((i: any) => i.key)).toEqual(keys.slice(2));
	expect(p2.body.nextCursor).toBeNull();
	expect((await call("GET", "/api/research-routes?cursor=@@")).status).toBe(
		400,
	);
	const forged = Buffer.from(
		JSON.stringify({ lastKey: keys[0], epoch: 0, scope: "other" }),
	).toString("base64url");
	expect(
		(await call("GET", `/api/research-routes?cursor=${forged}`)).status,
	).toBe(400);
	const tok = (await call("GET", "/api/research-routes")).body.epoch;
	const clear = await call("POST", "/api/research-routes/clear", {
		requestId: rid(),
		expectedEpoch: tok,
	});
	expect(clear.status).toBe(200);
	expect(
		(await call("GET", `/api/research-routes?cursor=${p1.body.nextCursor}`))
			.status,
	).toBe(409);
});

test("H01 stale token 409, request replay and body conflict, disable/rediscover never auto-activate", async () => {
	const env = await mk();
	const changes: unknown[] = [];
	const { call } = api(env, { changes });
	const c = await activateRoute(env);
	const token = (await call("GET", `/api/research-routes/${c.key}`)).body
		.stateToken;
	const stale = await call("POST", `/api/research-routes/${c.key}/disable`, {
		requestId: rid(),
		expectedStateToken: "0".repeat(64),
	});
	expect(stale.status).toBe(409);
	const id = rid();
	const body = { requestId: id, expectedStateToken: token };
	const d1 = await call("POST", `/api/research-routes/${c.key}/disable`, body);
	expect(d1.status).toBe(200);
	expect(d1.body.state).toBe("disabled");
	expect(d1.body.skillRevision).toBeNull();
	const d2 = await call("POST", `/api/research-routes/${c.key}/disable`, body);
	expect(d2).toEqual(d1);
	expect(changes).toHaveLength(1); // replay publishes nothing
	const conflict = await call("POST", `/api/research-routes/${c.key}/disable`, {
		...body,
		expectedStateToken: "1".repeat(64),
	});
	expect(conflict.status).toBe(409);
	expect(conflict.body.error).toBe("request_conflict");
	const lk = await env.store.write((db) =>
		env.routes.lookupInTransaction(db, c.spec, c.binding),
	);
	expect(lk.kind).toBe("disabled");
	const old = await call("POST", `/api/research-routes/${c.key}/rediscover`, {
		requestId: rid(),
		expectedStateToken: token,
	});
	expect(old.status).toBe(409);
	const re = await call("POST", `/api/research-routes/${c.key}/rediscover`, {
		requestId: rid(),
		expectedStateToken: d1.body.stateToken,
	});
	expect(re.status).toBe(200);
	expect(re.body.state).toBe("unregistered");
	expect(re.body.activeVersionId).toBeNull();
	expect(
		(
			await call("POST", `/api/research-routes/${"b".repeat(64)}/disable`, {
				requestId: rid(),
				expectedStateToken: token,
			})
		).status,
	).toBe(404);
});

test("H01 edit: description only; structural request 400; second edit 409; unhealthy route not editable", async () => {
	const env = await mk();
	const { call } = api(env);
	const c = await activateRoute(env);
	const token = (await call("GET", `/api/research-routes/${c.key}`)).body
		.stateToken;
	const structural = await call("POST", `/api/research-routes/${c.key}/edits`, {
		requestId: rid(),
		expectedStateToken: token,
		instruction: "取得先を変更して https://example.test/x を使って",
	});
	expect(structural.status).toBe(400);
	expect(structural.body.error).toBe("recipe_change_requires_rediscovery");
	const ok = await call("POST", `/api/research-routes/${c.key}/edits`, {
		requestId: rid(),
		expectedStateToken: token,
		instruction: "説明を短くする",
	});
	expect(ok.status).toBe(202);
	expect(ok.body.draftId).toMatch(/^[0-9a-f-]{36}$/);
	const shown = await call("GET", `/api/research-routes/${c.key}`);
	expect(shown.body.state).toBe("active"); // editing never hides a healthy route
	expect(shown.body.draftStatus).toMatchObject({
		id: ok.body.draftId,
		state: "queued",
	});
	const again = await call("POST", `/api/research-routes/${c.key}/edits`, {
		requestId: rid(),
		expectedStateToken: token,
		instruction: "もう一度",
	});
	expect(again.status).toBe(409);
	const d = await call("POST", `/api/research-routes/${c.key}/disable`, {
		requestId: rid(),
		expectedStateToken: token,
	});
	const noEdit = await call("POST", `/api/research-routes/${c.key}/edits`, {
		requestId: rid(),
		expectedStateToken: d.body.stateToken,
		instruction: "説明を直す",
	});
	expect(noEdit.status).toBe(409);
	expect(noEdit.body.error).toBe("route_not_editable");
});

test("H01 clear: stale epoch 409, replay keeps result and never deletes a recreated key", async () => {
	const env = await mk();
	const { call } = api(env);
	const c = await activateRoute(env);
	const oldToken = (await call("GET", `/api/research-routes/${c.key}`)).body
		.stateToken;
	expect(
		(
			await call("POST", "/api/research-routes/clear", {
				requestId: rid(),
				expectedEpoch: 5,
			})
		).status,
	).toBe(409);
	const id = rid();
	const first = await call("POST", "/api/research-routes/clear", {
		requestId: id,
		expectedEpoch: 0,
	});
	expect(first).toEqual({ status: 200, body: { epoch: 1, deletedKeys: 1 } });
	expect((await call("GET", `/api/research-routes/${c.key}`)).status).toBe(404);
	// the same key is recreated in the new epoch
	await env.store.write((db) =>
		env.routes.lookupInTransaction(db, c.spec, c.binding),
	);
	const replay = await call("POST", "/api/research-routes/clear", {
		requestId: id,
		expectedEpoch: 0,
	});
	expect(replay).toEqual(first);
	expect((await call("GET", "/api/research-routes")).body.items).toHaveLength(
		1,
	);
	// the old token cannot operate on the new incarnation
	const stale = await call("POST", `/api/research-routes/${c.key}/disable`, {
		requestId: rid(),
		expectedStateToken: oldToken,
	});
	expect(stale.status).toBe(409);
});

test("H01 control_busy (429) leaves state untouched when the receipt ledger is full", async () => {
	const env = await mk();
	const { call } = api(env);
	const c = await activateRoute(env);
	const token = (await call("GET", `/api/research-routes/${c.key}`)).body
		.stateToken;
	await env.store.write((db) => {
		for (let i = 0; i < 1024; i++)
			ledger.insertOperation(db, {
				scope: "research-routes:owner",
				request_id: `fill-${i}`,
				input_digest: "d",
				response_json: "{}",
				status: 200,
				created_at: NOW,
				expires_at: NOW + ttl.operationMs,
			});
	});
	const busy = await call("POST", `/api/research-routes/${c.key}/disable`, {
		requestId: rid(),
		expectedStateToken: token,
	});
	expect(busy.status).toBe(429);
	expect(busy.body.error).toBe("control_busy");
	expect((await call("GET", `/api/research-routes/${c.key}`)).body.state).toBe(
		"active",
	);
	env.advance(ttl.operationMs + 1);
	const retry = await call("POST", `/api/research-routes/${c.key}/disable`, {
		requestId: rid(),
		expectedStateToken: token,
	});
	expect(retry.status).toBe(200);
});
