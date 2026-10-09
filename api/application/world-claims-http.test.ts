/**
 * P5-02 on the REAL assembly and the real HTTP app: the claim routes exist only
 * with World configured, sit behind the same bearer token and origin check as
 * every other API route, and bind the Scope on the host side. Temp-file store,
 * production migrations; no model, no network.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContinuityService } from "../domains/continuity";
import { createConversationService } from "../domains/conversation";
import { createMemoryService } from "../domains/memory";
import {
	adoptPlan,
	claim,
	currentRef,
	entityOp,
	registerClaim,
	request,
	type Harness,
} from "../domains/world/test/fixture";
import { openStore } from "../infrastructure/sqlite";
import { createApp } from "./app";
import { migrations } from "./migrations";
import {
	createWorldAssembly,
	defaultWorldJournalPath,
	manualAccess,
	resolveWorldCursorSecret,
	type WorldAssembly,
} from "./world";

const token = "t".repeat(32);
const origin = "http://127.0.0.1:5173";
const auth = { authorization: `Bearer ${token}` };
const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

async function assemble(mode: "on" | "protect" | "off") {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-world-claims-"));
	dirs.push(dir);
	const dbPath = join(dir, "db.sqlite3");
	const store = openStore(dbPath, migrations);
	const conversation = createConversationService(store, {
		requireOutbox: true,
	});
	const memoryJournalPath = join(dir, "memory-forget-journal.jsonl");
	const memory = createMemoryService(
		store,
		conversation,
		createContinuityService(store),
		{ journalPath: memoryJournalPath },
	);
	let world: WorldAssembly | undefined;
	if (mode !== "off") {
		world = createWorldAssembly({
			store,
			conversation,
			memory,
			mode,
			journalPath: defaultWorldJournalPath(memoryJournalPath),
			cursorSecret: resolveWorldCursorSecret({ dbPath, env: {} }),
			pollMs: 60_000,
		});
		const recovery = await memory.recover();
		await world.recover({
			feedResyncRequired: recovery.feedResyncRequired === true,
		});
	}
	closers.push(async () => {
		await world?.close();
		await store.close().catch(() => {});
	});
	// Only the pieces the claim routes need; every other route is never called.
	const app = createApp({
		token,
		origin,
		conversation,
		dialogue: {} as never,
		voice: {} as never,
		larm: {
			status: () => ({ state: "ready" }),
			connect: async () => {},
		} as never,
		queue: {} as never,
		scheduler: {} as never,
		...(world
			? {
					worldClaims: {
						claims: world.claims,
						context: world.claimsContext,
					},
				}
			: {}),
	});
	return { store, conversation, world, app };
}

const get = (app: ReturnType<typeof createApp>, path: string, headers = auth) =>
	app.request(path, { headers });

async function seed(h: Awaited<ReturnType<typeof assemble>>) {
	const world = h.world!;
	await h.conversation.append({
		id: "m1",
		conversationId: "main",
		role: "user",
		text: "音声サービスは9月から利用できる。",
		createdAt: "2026-10-09T00:00:00.000Z",
		runId: null,
	});
	const harness = { conversation: h.conversation, store: h.store } as Harness;
	const apply = (key: string, operation: unknown) =>
		world.service.apply({
			...request(key, operation),
			access: manualAccess(),
		});
	expect((await apply("e", entityOp().operation)).status).toBe("applied");
	const ref = currentRef(harness, "m1");
	expect(
		(await apply("c", registerClaim("c", claim("claim-1", [ref])).operation))
			.status,
	).toBe("applied");
	expect(
		(
			await apply("a", {
				kind: "assertion.transition",
				plan: adoptPlan("claim-1", 1),
			})
		).status,
	).toBe("applied");
}

test("World OFF: the claim routes do not exist (404), and the token is still required first", async () => {
	const h = await assemble("off");
	expect((await get(h.app, "/api/world/claims")).status).toBe(404);
	expect((await get(h.app, "/api/world/status")).status).toBe(404);
	expect((await get(h.app, "/api/world/forgets")).status).toBe(404);
	const post = await h.app.request("/api/world/claims/retract", {
		method: "POST",
		headers: { ...auth, "content-type": "application/json" },
		body: "{}",
	});
	expect(post.status).toBe(404);
	// Without the token it is 401 whether or not the route exists.
	expect(
		(await get(h.app, "/api/world/claims", {} as typeof auth)).status,
	).toBe(401);
});

test("World configured: same bearer and origin rules as every API route", async () => {
	const h = await assemble("on");
	for (const path of [
		"/api/world/status",
		"/api/world/claims",
		"/api/world/claims/x",
		"/api/world/forgets",
	]) {
		expect((await get(h.app, path, {} as typeof auth)).status).toBe(401);
		expect(
			(await get(h.app, path, { authorization: "Bearer wrong" } as never))
				.status,
		).toBe(401);
		expect(
			(
				await get(h.app, path, {
					...auth,
					origin: "http://evil.example",
				} as never)
			).status,
		).toBe(403);
	}
	const unauthenticatedPost = await h.app.request("/api/world/claims/forget", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{}",
	});
	expect(unauthenticatedPost.status).toBe(401);
});

test("World ON: list, detail, status and forgets over HTTP; the Scope comes from the host", async () => {
	const h = await assemble("on");
	await seed(h);
	const status = await (await get(h.app, "/api/world/status")).json();
	expect(status).toMatchObject({
		mode: "on",
		enabled: true,
		usable: true,
		gateOpen: true,
		scopes: [{ scopeKey: "profile:owner" }],
	});
	const list = await get(h.app, "/api/world/claims");
	expect(list.status).toBe(200);
	const body = (await list.json()) as { items: { id: string; tone: string }[] };
	expect(body.items.map((r) => [r.id, r.tone])).toEqual([
		["claim-1", "adopted"],
	]);
	// A query string cannot pick another principal or Scope that was not granted.
	expect(
		(await get(h.app, "/api/world/claims?scopeKey=profile:other")).status,
	).toBe(404);
	expect((await get(h.app, "/api/world/claims/claim-1")).status).toBe(200);
	expect((await get(h.app, "/api/world/claims/nope")).status).toBe(404);
	expect(await (await get(h.app, "/api/world/forgets")).json()).toEqual({
		scopeKey: "profile:owner",
		forgets: [],
	});
});

test("World protect: routes exist, reads say world_disabled (409), nothing is ON", async () => {
	const h = await assemble("protect");
	const status = await (await get(h.app, "/api/world/status")).json();
	expect(status).toMatchObject({
		mode: "protect",
		enabled: false,
		usable: false,
	});
	const list = await get(h.app, "/api/world/claims");
	expect(list.status).toBe(409);
	expect(await list.json()).toEqual({ error: "world_disabled" });
});
