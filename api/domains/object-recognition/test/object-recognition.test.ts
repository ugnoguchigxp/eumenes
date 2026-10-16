import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { createQueue, migrations as queueMigrations } from "../../queue";
import { createObjectRecognition, migrations } from "..";
import { recognitionGateway } from "../service/gateway";
import {
	detectionResult,
	imageResult,
	videoResult,
	type Connection,
} from "../contracts";
import { waitFor as until } from "../../../infrastructure/wait-for";
const object = {
	classId: 41,
	label: "cup",
	confidence: 0.86,
	box: [10, 20, 50, 60],
};
const image = imageResult.parse({
	kind: "image",
	model: "YOLO26n",
	width: 100,
	height: 100,
	objects: [object],
});
const video = videoResult.parse({
	kind: "video",
	model: "YOLO26n",
	video: { width: 100, height: 100 },
	frames: [
		{ timestampSeconds: 0, objects: [object] },
		{ timestampSeconds: 0.5, objects: [] },
	],
});
const connection = {
	revision: 1,
	baseUrl: "http://127.0.0.1:18786",
	credential: "test-only-recognition-business-credential",
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const c of cleanups.splice(0)) await c();
});
function setup(fetcher: typeof fetch) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-recognition-"));
	const store = openStore(join(dir, "db"), [...queueMigrations, ...migrations]);
	let bound: Connection = connection;
	const queue = createQueue(store, {
		pollMs: 5,
		backoff: { baseMs: 10, maxMs: 10 },
	});
	const service = createObjectRecognition({
		store,
		queue,
		connection: () => bound,
		fetcher,
	});
	queue.start();
	cleanups.push(async () => {
		await queue.close(100);
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return {
		service,
		store,
		queue,
		rotateSharedCredential: () => {
			bound = {
				...bound,
				credential: "fixture-shared-rotated-credential",
				credentialVersion: "rotated-version",
			};
		},
		changeConnection: () => {
			bound = { ...connection, revision: 2 };
		},
	};
}
const response = (body: unknown, status = 200) =>
	Response.json(body, { status });
test("single file multipart and credentials remain at the bound gateway; statusUrl is not followed", async () => {
	const calls: string[] = [];
	const gateway = recognitionGateway(connection, (async (
		url: RequestInfo | URL,
		init?: RequestInit,
	) => {
		calls.push(String(url));
		expect(init?.headers).toEqual({
			Authorization: `Bearer ${connection.credential}`,
		});
		expect(init?.redirect).toBe("error");
		if (init?.method === "POST") {
			const form = init.body as FormData;
			expect([...form.keys()]).toEqual(["file"]);
			return response(
				{ id: "job1", statusUrl: "http://attacker.invalid/steal" },
				202,
			);
		}
		return response({ status: "completed", result: video });
	}) as unknown as typeof fetch);
	await gateway.analyze(
		new File(["video"], "clip.webm", { type: "video/webm" }),
		new AbortController().signal,
	);
	await gateway.status("job1", new AbortController().signal);
	expect(calls).toEqual([
		"http://127.0.0.1:18786/api/analyze",
		"http://127.0.0.1:18786/api/jobs/job1",
	]);
});
test("image result, source and observations persist; owner cannot read/cancel/delete/incorporate another input", async () => {
	let posts = 0;
	const h = setup((async () => {
		posts++;
		return response(image);
	}) as unknown as typeof fetch);
	const id = crypto.randomUUID();
	const file = new File(["png"], "desk.png", { type: "image/png" });
	await h.service.upload("alice", "main", file, id);
	await until(() => h.service.get("alice", id).state === "completed");
	await h.service.upload("alice", "main", file, id);
	expect(posts).toBe(1);
	expect(h.service.content("alice", id).bytes).toEqual(
		new Uint8Array([112, 110, 103]),
	);
	expect(h.service.conversationText("alice", id)).toContain(
		"cup [10, 20, 50, 60]",
	);
	expect(h.service.list("bob", "main")).toEqual([]);
	for (const op of [
		() => h.service.get("bob", id),
		() => h.service.content("bob", id),
		() => h.service.conversationText("bob", id),
	])
		expect(op).toThrow("recognition_not_found");
	await expect(h.service.cancel("bob", id)).rejects.toThrow(
		"recognition_not_found",
	);
	await expect(h.service.remove("bob", id)).rejects.toThrow(
		"recognition_not_found",
	);
	expect(JSON.stringify(h.service.get("alice", id))).not.toContain(
		connection.credential,
	);
	const stored = h.store.read((db) =>
		db.query("SELECT connection_json FROM object_recognition_inputs").get(),
	);
	expect(JSON.stringify(stored)).not.toContain(connection.credential);
});
test("video captures upstream id, stores numeric progress and timestamp results; reads never analyze again", async () => {
	let reads = 0,
		posts = 0;
	const h = setup((async (_url: RequestInfo | URL, init?: RequestInit) => {
		if (init?.method === "POST") {
			posts++;
			return response({ id: "job2", statusUrl: "/api/jobs/job2" }, 202);
		}
		reads++;
		return reads === 1
			? response({
					status: "queued",
					progress: {
						processedFrames: 1,
						totalFrames: 2,
						detail: "untrusted secret",
					},
				})
			: response({ status: "completed", result: video });
	}) as unknown as typeof fetch);
	const id = crypto.randomUUID();
	await h.service.upload(
		"alice",
		"main",
		new File(["clip"], "clip.webm", { type: "video/webm" }),
		id,
	);
	await until(() => h.service.get("alice", id).progress !== null);
	expect(h.service.get("alice", id).state).toBe("queued");
	expect(h.service.get("alice", id).progress).toEqual({
		processedFrames: 1,
		totalFrames: 2,
	});
	await until(() => h.service.get("alice", id).state === "completed");
	expect(h.service.get("alice", id).result).toEqual(video);
	expect(posts).toBe(1);
	expect(h.service.conversationText("alice", id, 1)).toContain(
		"0.5秒: 検出対象なし",
	);
});
test("cancel while initial POST is outstanding captures its receipt and cancels upstream; late completion is discarded", async () => {
	let release!: () => void;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	let cancelled = 0;
	const h = setup((async (url: RequestInfo | URL, init?: RequestInit) => {
		if (String(url).endsWith("/api/analyze")) {
			await gate;
			return response({ id: "job3", statusUrl: "/api/jobs/job3" }, 202);
		}
		if (init?.method === "POST") {
			cancelled++;
			return response({ status: "running" });
		}
		return response({ status: "completed", result: video });
	}) as unknown as typeof fetch);
	const id = crypto.randomUUID();
	await h.service.upload(
		"alice",
		"main",
		new File(["clip"], "clip.mov", { type: "video/quicktime" }),
		id,
	);
	await until(() => h.service.get("alice", id).state === "starting");
	expect((await h.service.cancel("alice", id)).state).toBe("cancelling");
	release();
	await until(() => h.service.get("alice", id).state === "cancelled");
	expect(cancelled).toBe(1);
	expect(h.service.get("alice", id).result).toBeNull();
	expect(h.service.get("alice", id).errorCode).toBe(
		"recognition_result_discarded",
	);
});
test("an uncertain analyze submission is never replayed and in-flight configuration changes invalidate results", async () => {
	let calls = 0;
	const h = setup((async () => {
		calls++;
		throw new TypeError("secret provider error");
	}) as unknown as typeof fetch);
	const id = crypto.randomUUID();
	await h.service.upload(
		"a",
		"main",
		new File(["png"], "a.png", { type: "image/png" }),
		id,
	);
	await until(() => h.service.get("a", id).state === "failed");
	expect(calls).toBe(1);
	expect(h.service.get("a", id).errorCode).toBe(
		"recognition_submission_unconfirmed",
	);
	let release!: () => void;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	const second = setup((async () => {
		await gate;
		return response(image);
	}) as unknown as typeof fetch);
	const id2 = crypto.randomUUID();
	await second.service.upload(
		"a",
		"main",
		new File(["png"], "a.png", { type: "image/png" }),
		id2,
	);
	await until(() => second.service.get("a", id2).state === "starting");
	second.changeConnection();
	release();
	await until(() => second.service.get("a", id2).state === "failed");
	expect(second.service.get("a", id2).result).toBeNull();
});
test("out of bounds coordinates, unsorted video times and unsupported formats are rejected", async () => {
	expect(
		detectionResult.safeParse({
			...image,
			objects: [{ ...object, box: [0, 0, 101, 50] }],
		}).success,
	).toBe(false);
	expect(
		detectionResult.safeParse({ ...video, frames: [...video.frames].reverse() })
			.success,
	).toBe(false);
	const h = setup((async () => response(image)) as unknown as typeof fetch);
	await expect(
		h.service.upload(
			"a",
			"main",
			new File(["pdf"], "a.pdf", { type: "application/pdf" }),
			crypto.randomUUID(),
		),
	).rejects.toThrow("invalid_recognition_format");
});

test("restarting the queue resumes a persisted video receipt without resubmitting analyze", async () => {
	let posts = 0;
	const fetcher = (async (_url: RequestInfo | URL, init?: RequestInit) => {
		if (init?.method === "POST") {
			posts++;
			return response(
				{ id: "saved-job", statusUrl: "/api/jobs/saved-job" },
				202,
			);
		}
		return response({ status: "completed", result: video });
	}) as typeof fetch;
	const h = setup(fetcher);
	const id = crypto.randomUUID();
	await h.service.upload(
		"a",
		"main",
		new File(["clip"], "clip.webm", { type: "video/webm" }),
		id,
	);
	await until(() =>
		h.store.read(
			(db) =>
				!!(
					db
						.query(
							"SELECT upstream_id FROM object_recognition_inputs WHERE id=?",
						)
						.get(id) as { upstream_id: string | null }
				).upstream_id,
		),
	);
	await h.queue.close(100);
	const queue = createQueue(h.store, { pollMs: 5 });
	const resumed = createObjectRecognition({
		store: h.store,
		queue,
		connection: () => connection,
		fetcher,
	});
	cleanups.unshift(async () => {
		await queue.close(100);
	});
	queue.start();
	await until(() => resumed.get("a", id).state === "completed");
	expect(posts).toBe(1);
	expect(resumed.get("a", id).result).toEqual(video);
});

test("cancel accepts an empty success response and reads actual terminal status; worker/gateway errors are bounded codes", async () => {
	const gateway = recognitionGateway(connection, (async (
		_url: RequestInfo | URL,
		init?: RequestInit,
	) =>
		init?.method === "POST"
			? new Response(null, { status: 204 })
			: response({ status: "cancelled" })) as typeof fetch);
	await gateway.cancel("job", new AbortController().signal);
	expect(
		(await gateway.status("job", new AbortController().signal)).status,
	).toBe("cancelled");
	for (const body of [
		{ detail: "sensitive worker error" },
		{ error: "sensitive gateway error" },
	]) {
		const busy = recognitionGateway(connection, (async () =>
			response(body, 503)) as unknown as typeof fetch);
		await expect(
			busy.analyze(
				new File(["x"], "a.png", { type: "image/png" }),
				new AbortController().signal,
			),
		).rejects.toThrow("recognition_busy");
	}
});

test("after a prolonged disconnect an explicit recheck resumes the saved id without a second POST", async () => {
	let offline = true,
		posts = 0;
	const h = setup((async (_url: RequestInfo | URL, init?: RequestInit) => {
		if (init?.method === "POST") {
			posts++;
			return response(
				{ id: "reconnect-job", statusUrl: "/api/jobs/reconnect-job" },
				202,
			);
		}
		if (offline) throw new TypeError("offline");
		return response({ status: "completed", result: video });
	}) as typeof fetch);
	const id = crypto.randomUUID();
	await h.service.upload(
		"a",
		"main",
		new File(["clip"], "clip.webm", { type: "video/webm" }),
		id,
	);
	await until(() => h.service.get("a", id).state === "failed");
	expect(h.service.get("a", id).canRecheck).toBe(true);
	offline = false;
	await h.service.recheck("a", id);
	await until(() => h.service.get("a", id).state === "completed");
	expect(posts).toBe(1);
	await expect(h.service.recheck("b", id)).rejects.toThrow(
		"recognition_not_found",
	);
});

test("a shared credential change invalidates an outstanding result even when the saved settings revision is unchanged", async () => {
	let release!: () => void;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	const h = setup((async () => {
		await gate;
		return response(image);
	}) as unknown as typeof fetch);
	const id = crypto.randomUUID();
	await h.service.upload(
		"a",
		"main",
		new File(["png"], "a.png", { type: "image/png" }),
		id,
	);
	await until(() => h.service.get("a", id).state === "starting");
	h.rotateSharedCredential();
	release();
	await until(() => h.service.get("a", id).state === "failed");
	expect(h.service.get("a", id).errorCode).toBe(
		"recognition_connection_changed",
	);
	expect(h.service.get("a", id).result).toBeNull();
});
