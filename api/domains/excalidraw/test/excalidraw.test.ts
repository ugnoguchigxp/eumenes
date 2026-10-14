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
const blank = {
	elements: [],
	appState: { viewBackgroundColor: "#ffffff" },
	files: {},
};
/** A new drawing exists upstream only after its first save. */
async function created(
	h: Awaited<ReturnType<typeof setup>>,
	input: Record<string, unknown> = {},
) {
	const s = await h.service.session({
		requestId: crypto.randomUUID(),
		...input,
	});
	await h.service.wait(s.id);
	const doc = await h.service.create(
		s.id,
		{ title: "図", scene: blank },
		crypto.randomUUID(),
		AbortSignal.timeout(1000),
	);
	return { ...h.service.get(s.id)!, doc };
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
		// Opening a new drawing leases only; nothing is stored until the first save.
		expect(ready.url).toBeNull();
		expect(ready.referenceId).toBeNull();
		expect(h.f.documents.size).toBe(0);
		expect(h.f.requests.some((r) => r.path.startsWith("/api/documents"))).toBe(
			false,
		);
		const createKey = crypto.randomUUID();
		const first = await h.service.create(
			starting.id,
			{ title: "構成図", scene: blank },
			createKey,
			AbortSignal.timeout(1000),
		);
		expect(first.revision).toBe(1);
		expect(h.service.get(starting.id)?.url).toMatch(
			/^http:\/\/127.0.0.1:5173\/#drawing\/.*\?revision=1$/,
		);
		// A retry after a lost response returns the same document, never a second one.
		expect(
			(
				await h.service.create(
					starting.id,
					{ title: "構成図", scene: blank },
					createKey,
					AbortSignal.timeout(1000),
				)
			).referenceId,
		).toBe(first.referenceId);
		expect(h.f.documents.size).toBe(1);
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
		expect(h.service.get(starting.id)?.url).toBe(
			`http://127.0.0.1:5173/#drawing/${reference.id}?revision=2`,
		);
		const afterRelease = h.f.requests.length;
		h.service.get(starting.id);
		expect(h.f.requests).toHaveLength(afterRelease);
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
		const s = await created(h);
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
		const s = await created(h);
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
		await created(h);
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
		const ready = await created(h, { conversationId });
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

test("a cancelled activity acquisition cannot release the replacement reconnect lease under the same session ID", async () => {
	const f = drawingFixture();
	const { drawingConnection } = await import("../service/connection");
	const c = drawingConnection(f.connection, { fetch: f.fetcher, pollMs: 1 });
	let continueEnsure!: () => void;
	f.delay(
		new Promise<void>((resolve) => {
			continueEnsure = resolve;
		}),
	);
	try {
		const old = c
			.ready("same-session", AbortSignal.timeout(1000))
			.catch((error) => error);
		await c.reset("same-session");
		const replacement = c.ready("same-session", AbortSignal.timeout(1000));
		continueEnsure();
		expect((await old).message).toBe("excalidraw_connection_invalidated");
		const ready = await replacement;
		expect(ready.status).toBe("ready");
		expect(
			[...f.leases.values()]
				.filter((lease) => lease.status === "ready")
				.map((lease) => lease.id),
		).toEqual([ready.id]);
	} finally {
		continueEnsure();
		await c.close();
	}
});

test("deleting a drawing removes the upstream document before its reference, within its conversation", async () => {
	const h = await setup();
	try {
		const kept = await created(h);
		const gone = await created(h);
		await expect(h.service.remove(gone.referenceId!, "other")).rejects.toThrow(
			"excalidraw_reference_not_found",
		);
		// Only a confirmed deletion (or a document that is gone) removes the reference.
		h.f.failSave(true);
		await expect(h.service.remove(gone.referenceId!, "main")).rejects.toThrow(
			"excalidraw_http_503",
		);
		expect(h.service.list("main")).toHaveLength(2);
		h.f.failSave(false);
		await h.service.remove(gone.referenceId!, "main");
		expect(h.service.list("main").map((r) => r.id)).toEqual([
			kept.referenceId!,
		]);
		expect(h.f.documents.has(gone.doc.id)).toBe(false);
		expect(h.f.documents.has(kept.doc.id)).toBe(true);
		// An upstream document that is already gone still releases its reference.
		h.f.documents.delete(kept.doc.id);
		await h.service.remove(kept.referenceId!, "main");
		expect(h.service.list("main")).toHaveLength(0);
		await expect(h.service.remove(kept.referenceId!, "main")).rejects.toThrow(
			"excalidraw_reference_not_found",
		);
		// Deletion releases its own lease and those of editors on the deleted drawings.
		expect(
			[...h.f.leases.values()].filter((l) => l.status === "ready"),
		).toHaveLength(0);
	} finally {
		await h.close();
	}
});

test("deleting closes editors still open on the drawing; a host without the delete route keeps the reference", async () => {
	const h = await setup();
	try {
		const open = await created(h);
		h.f.deleteRoute(false);
		await expect(h.service.remove(open.referenceId!, "main")).rejects.toThrow(
			"excalidraw_delete_unsupported",
		);
		expect(h.service.list("main")).toHaveLength(1);
		h.f.deleteRoute(true);
		await h.service.remove(open.referenceId!, "main");
		expect(h.service.get(open.id)?.state).toBe("closed");
		await expect(
			h.service.save(
				open.id,
				{ title: "x", scene: blank, expectedRevision: 1 },
				crypto.randomUUID(),
				AbortSignal.timeout(1000),
			),
		).rejects.toThrow("excalidraw_session_not_found");
		const reopened = await h.service.session({
			requestId: crypto.randomUUID(),
			title: "別",
		});
		await h.service.wait(reopened.id);
		await expect(
			h.service.session({
				requestId: crypto.randomUUID(),
				referenceId: open.referenceId!,
			}),
		).rejects.toThrow("excalidraw_reference_not_found");
	} finally {
		await h.close();
	}
});
test("concurrent first saves of one session create a single document", async () => {
	const h = await setup();
	try {
		const s = await h.service.session({ requestId: crypto.randomUUID() });
		await h.service.wait(s.id);
		const save = (title: string) =>
			h.service.create(
				s.id,
				{ title, scene: blank },
				crypto.randomUUID(),
				AbortSignal.timeout(1000),
			);
		const [a, b] = await Promise.all([save("一"), save("二")]);
		expect(a.referenceId).toBe(b.referenceId);
		expect(h.f.documents.size).toBe(1);
	} finally {
		await h.close();
	}
});

test("a first save retried on a new lease with the same key adopts the original document", async () => {
	const h = await setup();
	try {
		const key = crypto.randomUUID(),
			input = { title: "応答喪失", scene: blank };
		const first = await h.service.session({ requestId: crypto.randomUUID() });
		await h.service.wait(first.id);
		const original = await h.service.create(
			first.id,
			input,
			key,
			AbortSignal.timeout(1000),
		);
		// The response was lost: the editor opens a new lease and resends the same key and payload.
		await h.service.release(first.id);
		const retry = await h.service.session({ requestId: crypto.randomUUID() });
		await h.service.wait(retry.id);
		const again = await h.service.create(
			retry.id,
			input,
			key,
			AbortSignal.timeout(1000),
		);
		expect(again.id).toBe(original.id);
		expect(again.referenceId).toBe(original.referenceId);
		expect(h.f.documents.size).toBe(1);
		expect(h.service.list("main")).toHaveLength(1);
	} finally {
		await h.close();
	}
});
