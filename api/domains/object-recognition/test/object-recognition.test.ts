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
	expect(h.service.attachmentMaterial("alice", id).meta).toMatchObject({
		source: "object-recognition",
		captureSource: "file",
		objects: [{ label: "cup", box: [10, 20, 50, 60], score: 0.86 }],
	});
	expect(h.service.list("bob", "main")).toEqual([]);
	for (const op of [
		() => h.service.get("bob", id),
		() => h.service.content("bob", id),
		() => h.service.attachmentMaterial("bob", id),
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
	expect(() => h.service.attachmentMaterial("alice", id)).toThrow(
		"recognition_image_required",
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
test("a capture request binds the taken still once; failed detection still hands the image with empty meta", async () => {
	const h = setup(
		(async () =>
			new Response("down", { status: 503 })) as unknown as typeof fetch,
	);
	const port = h.service.port("alice");
	const runId = crypto.randomUUID();
	await h.store.write((db) =>
		port.invokeInTransaction(db, runId, "main", {
			operation: "manage",
			action: "capture",
			id: "",
			frameIndex: -1,
			source: "screen",
			question: "画面の内容を説明して",
		}),
	);
	expect(h.store.read((db) => port.resultInTransaction(db, runId))).toEqual({
		action: "capture",
		state: "awaiting_capture",
		source: "screen",
	});
	expect(h.service.handoffs("alice", "main")).toMatchObject([
		{ id: runId, source: "screen", state: "pending", recognitionId: null },
	]);
	expect(h.service.handoffs("bob", "main")).toEqual([]);
	const still = crypto.randomUUID();
	await h.service.upload(
		"alice",
		"main",
		new File(["jpg"], "screen.jpg", { type: "image/jpeg" }),
		still,
		"screen",
	);
	expect(h.service.get("alice", still).origin).toBe("screen");
	// The still must exist and be finished; the request needs it for a camera/screen source.
	await expect(h.service.handoffMaterial("alice", runId)).rejects.toThrow(
		"request_conflict",
	);
	await until(() => h.service.get("alice", still).state === "failed");
	await expect(h.service.handoffMaterial("bob", runId, still)).rejects.toThrow(
		"recognition_handoff_not_found",
	);
	const sent = await h.service.handoffMaterial("alice", runId, still);
	expect(sent.question).toBe("画面の内容を説明して");
	expect(sent.material.meta).toEqual({});
	expect(sent.material.mime).toBe("image/jpeg");
	await h.service.completeHandoff("alice", runId);
	expect(h.service.handoffs("alice", "main")).toEqual([]);
	// A resend of the same request returns the same still; another still is a conflict.
	expect(
		(await h.service.handoffMaterial("alice", runId, still)).material.name,
	).toBe("screen.jpg");
	await expect(
		h.service.handoffMaterial("alice", runId, crypto.randomUUID()),
	).rejects.toThrow("request_conflict");
});
test("ask hands a saved still on screen; the snapshot marks only an owned shown record; cancel closes a request", async () => {
	const h = setup((async () => response(image)) as unknown as typeof fetch);
	const port = h.service.port("alice");
	const id = crypto.randomUUID();
	await h.service.upload(
		"alice",
		"main",
		new File(["png"], "desk.png", { type: "image/png" }),
		id,
		"camera",
	);
	await until(() => h.service.get("alice", id).state === "completed");
	const viewing = {
		artifactRevisionId: "artifact:object-recognition.workspace@2",
		targetRef: id,
	};
	const snapshot = h.store.read(
		(db) => port.snapshotInTransaction(db, "main", viewing) as unknown[],
	);
	expect(snapshot).toMatchObject([{ id, kind: "image", shown: true }]);
	const other = h.store.read(
		(db) =>
			h.service
				.port("bob")
				.snapshotInTransaction(db, "main", viewing) as unknown[],
	);
	expect(other).toEqual([]);
	const elsewhere = h.store.read(
		(db) =>
			port.snapshotInTransaction(db, "main", {
				artifactRevisionId: "artifact:ui-compositions.studio@1",
				targetRef: id,
			}) as Array<Record<string, unknown>>,
	);
	expect(elsewhere[0]!.shown).toBeUndefined();
	const askRun = crypto.randomUUID();
	await h.store.write((db) =>
		port.invokeInTransaction(db, askRun, "main", {
			operation: "manage",
			action: "ask",
			id,
			frameIndex: -1,
			source: "camera",
			question: "この写真の服装を見て",
		}),
	);
	const asked = await h.service.handoffMaterial("alice", askRun);
	expect(asked.material.meta).toMatchObject({
		captureSource: "camera",
		image: { width: 100, height: 100 },
		objects: [{ label: "cup" }],
	});
	await expect(
		h.store.write((db) =>
			port.invokeInTransaction(db, crypto.randomUUID(), "main", {
				operation: "manage",
				action: "ask",
				id: crypto.randomUUID(),
				frameIndex: -1,
				source: "camera",
				question: "",
			}),
		),
	).rejects.toThrow("recognition_not_found");
	const captureRun = crypto.randomUUID();
	await h.store.write((db) =>
		port.invokeInTransaction(db, captureRun, "main", {
			operation: "manage",
			action: "capture",
			id: "",
			frameIndex: -1,
			source: "camera",
			question: "今日の服どう？",
		}),
	);
	expect((await h.service.cancelHandoff("alice", captureRun)).state).toBe(
		"cancelled",
	);
	await expect(
		h.service.handoffMaterial("alice", captureRun, id),
	).rejects.toThrow("recognition_handoff_closed");
});

test("a capture is bound to the first still uploaded for it; a run that already carries an image takes none", async () => {
	const many = {
		...image,
		objects: Array.from({ length: 150 }, (_, i) => ({
			...object,
			label: `thing${i}`,
			confidence: i / 1000,
			box: [10.4, 20.6, 50, 60],
		})),
	};
	const h = setup((async () => response(many)) as unknown as typeof fetch);
	const port = h.service.port("alice");
	const runId = crypto.randomUUID();
	const capture = {
		operation: "manage",
		action: "capture",
		id: "",
		frameIndex: -1,
		source: "camera",
		question: "見て",
	};
	await h.store.write((db) =>
		port.invokeInTransaction(db, runId, "main", capture),
	);
	const first = crypto.randomUUID(),
		second = crypto.randomUUID();
	const jpg = new File(["jpg"], "camera.jpg", { type: "image/jpeg" });
	await h.service.upload("alice", "main", jpg, first, "camera", runId);
	await h.service.upload("alice", "main", jpg, second, "camera", runId);
	expect(h.service.handoffs("alice", "main")[0]!.recognitionId).toBe(first);
	await until(() => h.service.get("alice", first).state === "completed");
	// A request needs no recognition id once the host bound one; another still conflicts.
	const sent = await h.service.handoffMaterial("alice", runId);
	await expect(
		h.service.handoffMaterial("alice", runId, second),
	).rejects.toThrow("request_conflict");
	const meta = sent.material.meta as {
		objects: { label: string; box: number[]; score: number }[];
		notes: string[];
	};
	expect(meta.objects).toHaveLength(100);
	expect(meta.objects[0]).toEqual({
		label: "thing149",
		box: [10, 21, 50, 60],
		score: 0.149,
	});
	expect(meta.notes.at(-1)).toBe(
		"only the 100 highest-scoring of 150 detections are listed",
	);
	expect(JSON.stringify(meta).length).toBeLessThan(16 * 1024);
	// The sent message carries the image: a capture or ask on it shows that image instead.
	const followUp = crypto.randomUUID();
	await h.store.write((db) =>
		port.invokeInTransaction(db, followUp, "main", capture, {
			inputImages: 1,
		}),
	);
	expect(h.store.read((db) => port.resultInTransaction(db, followUp))).toEqual({
		action: "capture",
		state: "already_attached",
	});
	expect(
		h.service.handoffs("alice", "main").some((x) => x.id === followUp),
	).toBe(false);
	// Cancelling while the image was prepared stops the send.
	await h.service.cancelHandoff("alice", runId);
	expect(() => h.service.assertHandoffOpen("alice", runId)).toThrow(
		"recognition_handoff_closed",
	);
});
