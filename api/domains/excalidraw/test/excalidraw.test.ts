import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { createExcalidraw } from "..";
import { migrations } from "../repository";
import { drawingFixture } from "./connection.fixture";
async function setup() {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-drawing-"));
	const store = openStore(join(dir, "db"), [
		{ id: "queue/0001-init", sql: "SELECT 1" },
		...migrations,
	]);
	const f = drawingFixture();
	let now = Date.now();
	const deps = {
		store,
		connection: f.connection,
		webOrigin: "http://127.0.0.1:5173",
		fetch: f.fetcher,
		pollMs: 1,
		clock: () => now,
	};
	const service = createExcalidraw(deps);
	return {
		store,
		f,
		service,
		deps,
		advance(ms: number) {
			now += ms;
		},
		async close() {
			await service.close();
			await store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
test("cold startup returns only an authenticated browser entry; save creates confirmed versions, idle/poll/restart preserve the reference", async () => {
	const h = await setup();
	try {
		const input = { requestId: crypto.randomUUID(), title: "構成図" };
		const starting = await h.service.session(input);
		expect(starting.state).toBe("starting");
		expect(starting.url).toBeNull();
		const ready = (await h.service.wait(starting.id))!;
		expect(ready.state).toBe("ready");
		expect(ready.url).toMatch(
			/^http:\/\/127.0.0.1:5173\/#drawing\/.*\?revision=1$/,
		);
		expect(
			h.f.requests.find(
				(r) => r.method === "POST" && r.path.endsWith("/leases"),
			)!.body,
		).toEqual({});
		expect((await h.service.session(input)).id).toBe(starting.id);
		await expect(
			h.service.session({ ...input, title: "別の図" }),
		).rejects.toThrow("excalidraw_request_conflict");
		const doc = await h.service.document(
			starting.id,
			AbortSignal.timeout(1000),
		);
		const update = {
			title: "保存した図",
			expectedRevision: doc.revision,
			scene: { ...doc.scene, elements: [{ type: "rectangle", id: "shape" }] },
		};
		const key = crypto.randomUUID();
		const saved = await h.service.save(
			starting.id,
			update,
			key,
			AbortSignal.timeout(1000),
		);
		expect(saved.revision).toBe(2);
		const duplicate = await h.service.save(
			starting.id,
			update,
			key,
			AbortSignal.timeout(1000),
		);
		expect(duplicate.revision).toBe(2);
		const reference = h.service.list("main")[0]!;
		expect(reference.documentId).toBe(doc.id);
		expect(reference.revision).toBe(2);
		const before = h.f.requests.length;
		h.advance(31000);
		for (let i = 0; i < 8; i++) h.service.get(starting.id);
		expect(h.f.requests).toHaveLength(before);
		await h.service.tick();
		expect(h.service.get(starting.id)?.state).toBe("idle");
		expect(h.f.requests.at(-1)?.method).toBe("DELETE");
		h.f.stop();
		const restored = await h.service.document(
			starting.id,
			AbortSignal.timeout(1000),
		);
		expect(restored.scene).toEqual(saved.scene);
		await h.service.close();
		const restarted = createExcalidraw(h.deps);
		await restarted.recover();
		expect(restarted.get(starting.id)?.state).toBe("idle");
		const reopened = await restarted.session({
			requestId: crypto.randomUUID(),
			referenceId: reference.id,
			revision: 1,
		});
		await restarted.wait(reopened.id);
		expect(
			(await restarted.document(reopened.id, AbortSignal.timeout(1000))).scene
				.elements,
		).toHaveLength(0);
		expect(restarted.list("main")[0]?.title).toBe(saved.title);
		expect(restarted.list("main")[0]?.revision).toBe(2);
		await restarted.close();
	} finally {
		await h.close();
	}
});
test("save failure never advances the reference; retries are idempotent and old revisions conflict", async () => {
	const h = await setup();
	try {
		const s = await h.service.session({ requestId: crypto.randomUUID() });
		await h.service.wait(s.id);
		const d = await h.service.document(s.id, AbortSignal.timeout(1000)),
			body = { title: "retry", expectedRevision: d.revision, scene: d.scene },
			key = crypto.randomUUID();
		h.f.failSave(true);
		await expect(
			h.service.save(s.id, body, key, AbortSignal.timeout(1000)),
		).rejects.toThrow("excalidraw_http_503");
		expect(h.service.list("main")[0]?.revision).toBe(1);
		expect(h.service.get(s.id)?.errorCode).toBe("excalidraw_save_failed");
		h.f.failSave(false);
		expect(
			(await h.service.save(s.id, body, key, AbortSignal.timeout(1000)))
				.revision,
		).toBe(2);
		await expect(
			h.service.save(
				s.id,
				body,
				crypto.randomUUID(),
				AbortSignal.timeout(1000),
			),
		).rejects.toThrow("excalidraw_revision_conflict");
	} finally {
		await h.close();
	}
});
test("binding changes are rejected; closing during startup discards the late result and releases only its own lease", async () => {
	const h = await setup();
	try {
		const s = await h.service.session({ requestId: crypto.randomUUID() });
		await h.service.wait(s.id);
		h.f.changeBinding();
		await expect(
			h.service.document(s.id, AbortSignal.timeout(1000)),
		).rejects.toThrow("local_service_binding_changed");
	} finally {
		await h.close();
	}
	const h2 = await setup();
	let release!: () => void;
	try {
		h2.f.delay(
			new Promise((r) => {
				release = r;
			}),
		);
		const s = await h2.service.session({ requestId: crypto.randomUUID() });
		await h2.service.release(s.id);
		release();
		await h2.service.wait(s.id);
		expect(h2.service.get(s.id)?.state).toBe("closed");
		expect(h2.service.list("main")).toHaveLength(0);
		expect(h2.f.requests.some((r) => r.method === "DELETE")).toBe(true);
	} finally {
		release();
		await h2.close();
	}
});
test("a reference cannot be reopened under a different conversation", async () => {
	const h = await setup();
	try {
		const s = await h.service.session({ requestId: crypto.randomUUID() });
		await h.service.wait(s.id);
		await expect(
			h.service.session({
				requestId: crypto.randomUUID(),
				referenceId: h.service.list("main")[0]!.id,
				conversationId: "other",
			}),
		).rejects.toThrow("excalidraw_reference_not_found");
	} finally {
		await h.close();
	}
});

test("a real HTTP relay preserves the native gateway Host across a different Mac-side port", async () => {
	const f = drawingFixture();
	const relay = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			return Response.json({
				host: request.headers.get("host"),
				hasOrigin: request.headers.has("origin"),
				hasCookie: request.headers.has("cookie"),
				authorized:
					request.headers.get("authorization") ===
					"Bearer " + "business-".repeat(5),
			});
		},
	});
	const { drawingConnection } = await import("../service/connection");
	const c = drawingConnection(
		() => ({ ...f.connection(), gatewayUrl: relay.url.origin + "/" }),
		{ pollMs: 1 },
	);
	try {
		const result = await c.request(
			"relay-test",
			"/api/documents",
			AbortSignal.timeout(1000),
		);
		expect(result).toEqual({
			host: "127.0.0.1:18790",
			hasOrigin: false,
			hasCookie: false,
			authorized: true,
		});
	} finally {
		await c.close();
		await relay.stop(true);
	}
});

test("browser entry retains the owning conversation and can reopen its version without weakening reference boundaries", async () => {
	const h = await setup();
	try {
		const conversationId = "design / 構成 & review";
		const opening = await h.service.session({
			requestId: crypto.randomUUID(),
			conversationId,
		});
		const ready = (await h.service.wait(opening.id))!;
		const hash = new URL(ready.url!).hash;
		const query = new URLSearchParams(hash.slice(hash.indexOf("?") + 1));
		expect(query.get("conversationId")).toBe(conversationId);
		const reopened = await h.service.session({
			requestId: crypto.randomUUID(),
			conversationId: query.get("conversationId"),
			referenceId: ready.referenceId,
			revision: Number(query.get("revision")),
		});
		expect((await h.service.wait(reopened.id))?.state).toBe("ready");
		await expect(
			h.service.session({
				requestId: crypto.randomUUID(),
				referenceId: ready.referenceId,
			}),
		).rejects.toThrow("excalidraw_reference_not_found");
	} finally {
		await h.close();
	}
});
