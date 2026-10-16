import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { createQueue, migrations as queueMigrations } from "../../queue";
import { createOcr, migrations } from "..";
import { ocrGateway } from "../service/gateway";
import { imageResult, videoResult, type Connection } from "../contracts";
import { binding } from "../repository";
import { waitFor as until } from "../../../infrastructure/wait-for";
const line = {
	text: "原文のまま",
	confidence: 0.72,
	polygon: [
		[1, 2],
		[31, 2],
		[31, 18],
		[1, 18],
	],
};
const image = imageResult.parse({
	kind: "image",
	model: "ocr-fixture",
	width: 100,
	height: 100,
	text: "原文のまま",
	lines: [line],
});
const video = videoResult.parse({
	kind: "video",
	model: "ocr-fixture",
	video: { width: 100, height: 100 },
	frames: [
		{ timestampSeconds: 0, text: "原文のまま", lines: [line] },
		{ timestampSeconds: 0.5, text: "次の行", lines: [] },
	],
});
const connection = {
	revision: 1,
	baseUrl: "http://127.0.0.1:18794/",
	credential: "fixture-secret",
	credentialVersion: "v1",
};
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const c of cleanup.splice(0)) await c();
});
function setup(fetcher: typeof fetch) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-ocr-"));
	const store = openStore(join(dir, "db"), [...queueMigrations, ...migrations]);
	const queue = createQueue(store, {
		pollMs: 5,
		backoff: { baseMs: 10, maxMs: 10 },
	});
	const connectionState: { current: Connection | null } = {
		current: connection,
	};
	const service = createOcr({
		store,
		queue,
		connection: () => connectionState.current,
		fetcher,
	});
	queue.start();
	cleanup.push(async () => {
		await queue.close(100);
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return { service, store, connectionState };
}
test("OCR gateway sends only one multipart file and ignores untrusted statusUrl", async () => {
	const calls: string[] = [];
	const gateway = ocrGateway(connection, (async (
		url: RequestInfo | URL,
		init?: RequestInit,
	) => {
		calls.push(String(url));
		expect(new Headers(init?.headers).get("Authorization")).toBe(
			`Bearer ${connection.credential}`,
		);
		if (init?.method === "POST") {
			expect([...(init.body as FormData).keys()]).toEqual(["file"]);
			return Response.json(
				{ id: "job1", statusUrl: "https://attacker.invalid/steal" },
				{ status: 202 },
			);
		}
		return Response.json({ status: "completed", result: video });
	}) as unknown as typeof fetch);
	await gateway.analyze(
		new File(["clip"], "clip.webm", { type: "video/webm" }),
		new AbortController().signal,
	);
	await gateway.status("job1", new AbortController().signal);
	expect(calls).toEqual([
		"http://127.0.0.1:18794/api/analyze",
		"http://127.0.0.1:18794/api/jobs/job1",
	]);
});
test("image OCR stores raw lines and source, replay does not POST twice, owner is checked", async () => {
	let posts = 0;
	const h = setup((async () => {
		posts++;
		return Response.json(image);
	}) as unknown as typeof fetch);
	const id = crypto.randomUUID();
	const file = new File(["png"], "note.png", { type: "image/png" });
	await h.service.upload("alice", "main", file, id);
	await until(() => h.service.get("alice", id).state === "completed");
	await h.service.upload("alice", "main", file, id);
	expect(posts).toBe(1);
	expect(h.service.get("alice", id).result).toEqual(image);
	expect(h.service.conversationText("alice", id, undefined, [0])).toContain(
		"原文のまま",
	);
	expect(h.service.conversationText("alice", id)).toContain(
		"polygon=[[1,2],[31,2],[31,18],[1,18]]",
	);
	expect(h.service.content("alice", id).bytes).toEqual(
		new Uint8Array([112, 110, 103]),
	);
	expect(() => h.service.get("bob", id)).toThrow("ocr_not_found");
	expect(() => h.service.conversationText("bob", id)).toThrow("ocr_not_found");
	await expect(h.service.cancel("bob", id)).rejects.toThrow("ocr_not_found");
	await expect(h.service.remove("bob", id)).rejects.toThrow("ocr_not_found");
	expect(JSON.stringify(h.service.get("alice", id))).not.toContain(
		connection.credential,
	);
	const bound = h.store.read((db) =>
		db.query("SELECT connection_json FROM ocr_inputs").get(),
	);
	expect(JSON.stringify(bound)).not.toContain(connection.credential);
});
test("video job tracks status and returns selected timestamp without resubmitting", async () => {
	let posts = 0,
		reads = 0;
	const h = setup((async (_url: RequestInfo | URL, init?: RequestInit) => {
		if (init?.method === "POST") {
			posts++;
			return Response.json(
				{ id: "job2", statusUrl: "/api/jobs/job2" },
				{ status: 202 },
			);
		}
		reads++;
		return reads === 1
			? Response.json({
					status: "running",
					progress: { processedFrames: 1, totalFrames: 2, detail: "untrusted" },
				})
			: Response.json({ status: "completed", result: video });
	}) as unknown as typeof fetch);
	const id = crypto.randomUUID();
	await h.service.upload(
		"alice",
		"main",
		new File(["clip"], "clip.webm", { type: "video/webm" }),
		id,
	);
	await until(() => h.service.get("alice", id).state === "completed");
	expect(posts).toBe(1);
	expect(h.service.get("alice", id).result).toEqual(video);
	expect(h.service.conversationText("alice", id, 1)).toContain("0.5秒");
	expect(h.service.get("alice", id).progress).not.toHaveProperty("detail");
});
test("cancelling a video discards a late completed result", async () => {
	let posts = 0;
	const h = setup((async (_url: RequestInfo | URL, init?: RequestInit) => {
		if (init?.method === "POST" && String(_url).endsWith("/api/analyze")) {
			posts++;
			return Response.json(
				{ id: "job-cancel", statusUrl: "/api/jobs/job-cancel" },
				{ status: 202 },
			);
		}
		if (String(_url).endsWith("/cancel"))
			return Response.json({ status: "running" });
		return Response.json({ status: "completed", result: video });
	}) as unknown as typeof fetch);
	const id = crypto.randomUUID();
	await h.service.upload(
		"alice",
		"main",
		new File(["clip"], "cancel.webm", { type: "video/webm" }),
		id,
	);
	await until(() =>
		h.store.read(
			(db) =>
				!!db
					.query(
						"SELECT upstream_id FROM ocr_inputs WHERE id=? AND upstream_id IS NOT NULL",
					)
					.get(id),
		),
	);
	await h.service.cancel("alice", id);
	await until(() => h.service.get("alice", id).state === "cancelled");
	expect(h.service.get("alice", id).result).toBeNull();
	expect(posts).toBe(1);
});
test("capacity counts active records beyond the 100-item history page", async () => {
	const h = setup((async () =>
		Response.json(image)) as unknown as typeof fetch);
	await h.store.write((db) => {
		for (let i = 0; i < 104; i++) {
			const id = crypto.randomUUID();
			db.query(
				"INSERT INTO ocr_inputs(id,owner,conversation_id,mime,bytes,record_json,connection_json,deadline) VALUES(?,?,?,?,?,?,?,?)",
			).run(
				id,
				"alice",
				"main",
				"image/png",
				new Uint8Array([1]),
				JSON.stringify({ state: i < 3 ? "queued" : "completed" }),
				binding(connection),
				0,
			);
		}
	});
	expect(h.service.list("alice", "main")).toHaveLength(100);
	await expect(
		h.service.upload(
			"alice",
			"main",
			new File(["png"], "new.png", { type: "image/png" }),
			crypto.randomUUID(),
		),
	).rejects.toThrow("ocr_capacity");
});
test("recheck is unavailable after connection changes", async () => {
	const h = setup((async () =>
		Response.json(image)) as unknown as typeof fetch);
	const id = crypto.randomUUID();
	await h.service.upload(
		"alice",
		"main",
		new File(["png"], "note.png", { type: "image/png" }),
		id,
	);
	await until(() => h.service.get("alice", id).state === "completed");
	const completed = h.service.get("alice", id);
	await h.store.write((db) => {
		db.query(
			"UPDATE ocr_inputs SET upstream_id=?, record_json=? WHERE id=?",
		).run(
			"upstream-1",
			JSON.stringify({
				...completed,
				state: "failed",
				errorCode: "ocr_upstream_failed",
				result: null,
			}),
			id,
		);
	});
	expect(h.service.get("alice", id).canRecheck).toBe(true);
	h.connectionState.current = { ...connection, revision: 2 };
	expect(h.service.get("alice", id).canRecheck).toBe(false);
	await expect(h.service.recheck("alice", id)).rejects.toThrow(
		"ocr_connection_changed",
	);
	h.connectionState.current = connection;
	expect((await h.service.recheck("alice", id)).canRecheck).toBe(false);
});
test("deleting a source removes retained command results", async () => {
	const h = setup((async () =>
		Response.json(image)) as unknown as typeof fetch);
	const id = crypto.randomUUID();
	await h.service.upload(
		"alice",
		"main",
		new File(["png"], "note.png", { type: "image/png" }),
		id,
	);
	await until(() => h.service.get("alice", id).state === "completed");
	const requestId = crypto.randomUUID();
	await h.store.write((db) =>
		h.service.commandInTransaction(db, "alice", "main", "read", id, requestId),
	);
	expect(
		h.store.read((db) =>
			h.service.commandResultInTransaction(db, "alice", requestId),
		),
	).toBeTruthy();
	await h.service.remove("alice", id);
	expect(
		h.store.read((db) =>
			h.service.commandResultInTransaction(db, "alice", requestId),
		),
	).toBeNull();
});
test("upload replay returns its receipt after configuration is removed", async () => {
	const h = setup((async () =>
		Response.json(image)) as unknown as typeof fetch);
	const id = crypto.randomUUID();
	const file = new File(["png"], "note.png", { type: "image/png" });
	await h.service.upload("alice", "main", file, id);
	h.connectionState.current = null;
	expect((await h.service.upload("alice", "main", file, id)).id).toBe(id);
});
test("conversation export reports the dialogue size limit before submission", async () => {
	const large = imageResult.parse({ ...image, text: "字".repeat(8100) });
	const h = setup((async () =>
		Response.json(large)) as unknown as typeof fetch);
	const id = crypto.randomUUID();
	await h.service.upload(
		"alice",
		"main",
		new File(["png"], "long.png", { type: "image/png" }),
		id,
	);
	await until(() => h.service.get("alice", id).state === "completed");
	expect(() => h.service.conversationText("alice", id)).toThrow(
		"ocr_text_too_large",
	);
	expect(h.service.conversationText("alice", id, undefined, [0])).toContain(
		"原文のまま",
	);
});
