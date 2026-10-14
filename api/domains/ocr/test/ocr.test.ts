import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { createQueue, migrations as queueMigrations } from "../../queue";
import { createOcr, migrations } from "..";
import { ocrGateway } from "../service/gateway";
import { imageResult, videoResult } from "../contracts";
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
async function until(check: () => boolean) {
	for (let i = 0; i < 200; i++) {
		if (check()) return;
		await Bun.sleep(10);
	}
	throw new Error("condition_not_reached");
}
function setup(fetcher: typeof fetch) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-ocr-"));
	const store = openStore(join(dir, "db"), [...queueMigrations, ...migrations]);
	const queue = createQueue(store, {
		pollMs: 5,
		backoff: { baseMs: 10, maxMs: 10 },
	});
	const service = createOcr({
		store,
		queue,
		connection: () => connection,
		fetcher,
	});
	queue.start();
	cleanup.push(async () => {
		await queue.close(100);
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return { service, store };
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
