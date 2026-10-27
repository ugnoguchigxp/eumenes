import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { Hono } from "hono";
import { openStore } from "../../infrastructure/sqlite";
import { sha256Hex } from "../../infrastructure/digest";
import { waitFor } from "../../infrastructure/wait-for";
import {
	createQueue,
	migrations as queueMigrations,
} from "../../domains/queue";
import {
	createImage,
	migrations as imageMigrations,
} from "../../domains/image";
import {
	createObjectRecognition,
	registerObjectRecognition,
	migrations as recognitionMigrations,
	type ObjectRecognitionService,
} from "../../domains/object-recognition";
import { createLarmPlayground } from "../../domains/larm";
import { registerCaptureLibrary } from "./capture-library";

test("camera and screen stills persist in a durable queue and import as WebP without importing files or videos", async () => {
	const dir = mkdtempSync(join(tmpdir(), "capture-library-"));
	const store = openStore(join(dir, "db"), [
		...queueMigrations,
		...imageMigrations,
		...recognitionMigrations,
	]);
	const queue = createQueue(store, { pollMs: 5 });
	const imports: string[] = [];
	const unavailable = new Set<string>();
	let token = "test";
	let switchOnContent: string | undefined;
	const gateway = () =>
		createLarmPlayground({
			baseUrl: "http://127.0.0.1:1234",
			token,
			audience: "test",
			fetch: (async (url, init) => {
				if (new URL(String(url)).pathname !== "/v1/image-artifacts/imports")
					return Response.json(
						{ error: { code: "not_found", message: "missing" } },
						{ status: 404 },
					);
				const id = new Headers(init?.headers).get("Idempotency-Key")!;
				if (unavailable.has(id))
					return Response.json(
						{ error: { code: "import_unavailable", message: "unavailable" } },
						{ status: 503 },
					);
				const file = (init!.body as FormData).get("file") as File;
				const bytes = new Uint8Array(await file.arrayBuffer());
				const meta = await sharp(bytes).metadata();
				expect(meta.format).toBe("webp");
				expect(meta.width).toBeLessThanOrEqual(2000);
				imports.push(id);
				const now = Date.now();
				return Response.json(
					{
						requestId: id,
						createdAt: new Date(now).toISOString(),
						expiresAt: new Date(now + 86400000).toISOString(),
						statusUrl: `/v1/image-imports/${id}`,
						status: "succeeded",
						deleted: false,
						artifact: {
							id: `image-${id}`,
							createdAt: new Date(now).toISOString(),
							format: "webp",
							mimeType: "image/webp",
							width: meta.width,
							height: meta.height,
							hasAlpha: !!meta.hasAlpha,
							bytes: bytes.length,
							sha256: sha256Hex(bytes),
							contentUrl: `/v1/image-artifacts/image-${id}/content`,
						},
					},
					{ status: 201 },
				);
			}) as typeof fetch,
		});
	const image = createImage({
		store,
		queue,
		gateway,
		inference: {} as never,
		capabilities: {} as never,
		onJob: () => {},
		onFinished: () => {},
	});
	let recognition!: ObjectRecognitionService;
	const captureSaveInTransaction = registerCaptureLibrary(
		queue,
		image,
		() => ({
			...recognition,
			content: (owner, id) => {
				const content = recognition.content(owner, id);
				if (id === switchOnContent) token = "changed";
				return content;
			},
		}),
		() => gateway().imageImports.identity,
	);
	recognition = createObjectRecognition({
		store,
		queue,
		captureSaveInTransaction,
		connection: () => ({
			revision: 1,
			baseUrl: "http://fixture.invalid",
			credential: "fixture",
		}),
		fetcher: (async () =>
			Response.json({
				kind: "image",
				model: "fixture",
				width: 120,
				height: 80,
				objects: [],
			})) as unknown as typeof fetch,
	});
	try {
		const bytes = await sharp({
			create: { width: 120, height: 80, channels: 3, background: "white" },
		})
			.jpeg()
			.toBuffer();
		const camera = crypto.randomUUID(),
			screen = crypto.randomUUID(),
			fileId = crypto.randomUUID(),
			video = crypto.randomUUID();
		const still = new File([bytes], "capture.jpg", { type: "image/jpeg" });
		await recognition.upload("owner", "main", still, camera, "camera");
		await recognition.upload("owner", "main", still, screen, "screen");
		expect(recognition.get("owner", camera).captureSave).toBe("queued");
		expect(recognition.get("owner", screen).captureSave).toBe("queued");
		// The queued work exists before any worker starts, like a restart after acceptance.
		queue.start();
		await waitFor(
			() =>
				recognition.get("owner", camera).captureSave !== "queued" &&
				recognition.get("owner", screen).captureSave !== "queued",
			{ timeout: 3000 },
		);
		expect([
			recognition.get("owner", camera).captureSave,
			recognition.get("owner", screen).captureSave,
		]).toEqual(["saved", "saved"]);
		await waitFor(
			() =>
				recognition.get("owner", camera).state === "completed" &&
				recognition.get("owner", screen).state === "completed",
		);
		await recognition.upload("owner", "main", still, fileId, "file");
		await recognition.upload(
			"owner",
			"main",
			new File(["video"], "video.webm", { type: "video/webm" }),
			video,
			"camera",
		);
		expect(recognition.get("owner", fileId).captureSave).toBeUndefined();
		expect(recognition.get("owner", video).captureSave).toBeUndefined();
		expect(imports.sort()).toEqual([camera, screen].sort());
		expect(recognition.content("owner", camera).mime).toBe("image/jpeg");
		await waitFor(
			() =>
				recognition.get("owner", fileId).state === "completed" &&
				recognition.get("owner", video).state === "failed",
		);
		const interrupted = crypto.randomUUID();
		unavailable.add(interrupted);
		await recognition.upload("owner", "main", still, interrupted, "camera");
		await waitFor(
			() =>
				recognition.get("owner", interrupted).captureSave === "unconfirmed" &&
				recognition.get("owner", interrupted).state === "completed",
		);
		const signal = new AbortController().signal;
		expect((await image.imports.read(interrupted, signal)).status).toBe(
			"ready",
		);
		unavailable.delete(interrupted);
		expect((await image.imports.resume(interrupted, signal)).status).toBe(
			"succeeded",
		);
		expect(imports).toContain(interrupted);
		const changing = crypto.randomUUID();
		switchOnContent = changing;
		await recognition.upload("owner", "main", still, changing, "camera");
		await waitFor(
			() => recognition.get("owner", changing).captureSave !== "queued",
		);
		expect(imports).not.toContain(changing);
	} finally {
		await queue.close(500);
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a queued capture is saved after the application store is reopened", async () => {
	const dir = mkdtempSync(join(tmpdir(), "capture-recovery-"));
	const path = join(dir, "db");
	const open = () =>
		openStore(path, [
			...queueMigrations,
			...imageMigrations,
			...recognitionMigrations,
		]);
	let store = open();
	let queue = createQueue(store, { pollMs: 5 });
	const saved: string[] = [];
	const image = {
		imports: {
			upload: async (id: string) => {
				saved.push(id);
				return { status: "succeeded", artifact: { id: "fixture" } };
			},
		},
	} as unknown as ReturnType<typeof createImage>;
	function attach() {
		let recognition!: ObjectRecognitionService;
		const captureSaveInTransaction = registerCaptureLibrary(
			queue,
			image,
			() => recognition,
			() => "fixture-connection",
		);
		recognition = createObjectRecognition({
			store,
			queue,
			captureSaveInTransaction,
			connection: () => ({
				revision: 1,
				baseUrl: "http://fixture.invalid",
				credential: "fixture",
			}),
			fetcher: (async () =>
				Response.json({
					kind: "image",
					model: "fixture",
					width: 2,
					height: 2,
					objects: [],
				})) as unknown as typeof fetch,
		});
		return recognition;
	}
	let recognition = attach();
	const id = crypto.randomUUID();
	try {
		await recognition.upload(
			"owner",
			"main",
			new File(["jpg"], "capture.jpg", { type: "image/jpeg" }),
			id,
			"screen",
		);
		expect(recognition.get("owner", id).captureSave).toBe("queued");
		await queue.close(500);
		await store.close();
		store = open();
		queue = createQueue(store, { pollMs: 5 });
		recognition = attach();
		queue.start();
		await waitFor(() => recognition.get("owner", id).captureSave === "saved");
		expect(saved).toEqual([id]);
	} finally {
		await queue.close(500);
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a completed recognition cannot be removed while its capture is waiting to save", async () => {
	const dir = mkdtempSync(join(tmpdir(), "capture-remove-"));
	const store = openStore(join(dir, "db"), [
		...queueMigrations,
		...imageMigrations,
		...recognitionMigrations,
	]);
	const queue = createQueue(store, { pollMs: 5 });
	let finish!: () => void;
	const gate = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const image = {
		imports: {
			upload: async () => {
				await gate;
				return { status: "succeeded", artifact: { id: "fixture" } };
			},
		},
	} as unknown as ReturnType<typeof createImage>;
	let recognition!: ObjectRecognitionService;
	const captureSaveInTransaction = registerCaptureLibrary(
		queue,
		image,
		() => recognition,
		() => "fixture-connection",
	);
	recognition = createObjectRecognition({
		store,
		queue,
		captureSaveInTransaction,
		connection: () => ({
			revision: 1,
			baseUrl: "http://fixture.invalid",
			credential: "fixture",
		}),
		fetcher: (async () =>
			Response.json({
				kind: "image",
				model: "fixture",
				width: 2,
				height: 2,
				objects: [],
			})) as unknown as typeof fetch,
	});
	const id = crypto.randomUUID();
	try {
		queue.start();
		await recognition.upload(
			"owner",
			"main",
			new File(["jpg"], "capture.jpg", { type: "image/jpeg" }),
			id,
			"camera",
		);
		await waitFor(() => recognition.get("owner", id).state === "completed");
		await expect(recognition.remove("owner", id)).rejects.toThrow(
			"recognition_not_ready",
		);
		finish();
		await waitFor(() => recognition.get("owner", id).captureSave === "saved");
		await recognition.remove("owner", id);
		expect(() => recognition.get("owner", id)).toThrow("recognition_not_found");
	} finally {
		finish();
		await queue.close(500);
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an interrupted running capture job is requeued with the same receipt", async () => {
	const dir = mkdtempSync(join(tmpdir(), "capture-running-recovery-"));
	const store = openStore(join(dir, "db"), [
		...queueMigrations,
		...imageMigrations,
		...recognitionMigrations,
	]);
	const first = createQueue(store, {
		pollMs: 5,
		backoff: { baseMs: 1, maxMs: 1 },
	});
	const second = createQueue(store, {
		pollMs: 5,
		backoff: { baseMs: 1, maxMs: 1 },
	});
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const calls: string[] = [];
	const image = {
		imports: {
			upload: async (id: string) => {
				calls.push(id);
				if (calls.length === 1) await gate;
				return { status: "succeeded", artifact: { id: "fixture" } };
			},
		},
	} as unknown as ReturnType<typeof createImage>;
	function attach(queue: ReturnType<typeof createQueue>) {
		let recognition!: ObjectRecognitionService;
		const captureSaveInTransaction = registerCaptureLibrary(
			queue,
			image,
			() => recognition,
			() => "fixture-connection",
		);
		recognition = createObjectRecognition({
			store,
			queue,
			captureSaveInTransaction,
			connection: () => ({
				revision: 1,
				baseUrl: "http://fixture.invalid",
				credential: "fixture",
			}),
			fetcher: (async () =>
				Response.json({
					kind: "image",
					model: "fixture",
					width: 2,
					height: 2,
					objects: [],
				})) as unknown as typeof fetch,
		});
		return recognition;
	}
	const recognition = attach(first);
	attach(second);
	const id = crypto.randomUUID();
	try {
		first.start();
		await recognition.upload(
			"owner",
			"main",
			new File(["jpg"], "capture.jpg", { type: "image/jpeg" }),
			id,
			"camera",
		);
		await waitFor(
			() =>
				calls.length === 1 &&
				recognition.get("owner", id).state === "completed",
		);
		await second.recover();
		expect(recognition.get("owner", id).captureSave).toBe("queued");
		second.start();
		await waitFor(() => recognition.get("owner", id).captureSave === "saved");
		expect(calls).toEqual([id, id]);
	} finally {
		release();
		await first.close(500);
		await second.close(500);
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a queued capture is not sent after the LARM connection changes", async () => {
	const dir = mkdtempSync(join(tmpdir(), "capture-connection-"));
	const store = openStore(join(dir, "db"), [
		...queueMigrations,
		...imageMigrations,
		...recognitionMigrations,
	]);
	const queue = createQueue(store, { pollMs: 5 });
	let connection = "first";
	let sent = 0;
	const image = {
		imports: {
			upload: async () => {
				sent++;
				return { status: "succeeded", artifact: { id: "fixture" } };
			},
		},
	} as unknown as ReturnType<typeof createImage>;
	let recognition!: ObjectRecognitionService;
	const captureSaveInTransaction = registerCaptureLibrary(
		queue,
		image,
		() => recognition,
		() => connection,
	);
	recognition = createObjectRecognition({
		store,
		queue,
		captureSaveInTransaction,
		connection: () => ({
			revision: 1,
			baseUrl: "http://fixture.invalid",
			credential: "fixture",
		}),
		fetcher: (async () =>
			Response.json({
				kind: "image",
				model: "fixture",
				width: 2,
				height: 2,
				objects: [],
			})) as unknown as typeof fetch,
	});
	const id = crypto.randomUUID();
	try {
		await recognition.upload(
			"owner",
			"main",
			new File(["jpg"], "capture.jpg", { type: "image/jpeg" }),
			id,
			"camera",
		);
		connection = "second";
		queue.start();
		await waitFor(() => recognition.get("owner", id).captureSave === "failed");
		expect(sent).toBe(0);
	} finally {
		await queue.close(500);
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an interrupted capture without an import receipt can be resumed on its original connection", async () => {
	const dir = mkdtempSync(join(tmpdir(), "capture-explicit-resume-"));
	const store = openStore(join(dir, "db"), [
		...queueMigrations,
		...imageMigrations,
		...recognitionMigrations,
	]);
	const queue = createQueue(store, { pollMs: 5 });
	let connection = "first";
	const calls: string[] = [];
	const image = {
		imports: {
			upload: async (id: string) => {
				calls.push(id);
				if (calls.length === 1) throw new Error("shutdown");
				return { status: "succeeded", artifact: { id: "fixture" } };
			},
		},
	} as unknown as ReturnType<typeof createImage>;
	let recognition!: ObjectRecognitionService;
	const enqueue = registerCaptureLibrary(
		queue,
		image,
		() => recognition,
		() => connection,
	);
	recognition = createObjectRecognition({
		store,
		queue,
		captureSaveInTransaction: enqueue,
		captureResumeInTransaction: enqueue.resumeInTransaction,
		connection: () => ({
			revision: 1,
			baseUrl: "http://fixture.invalid",
			credential: "fixture",
		}),
		fetcher: (async () =>
			Response.json({
				kind: "image",
				model: "fixture",
				width: 2,
				height: 2,
				objects: [],
			})) as unknown as typeof fetch,
	});
	const id = crypto.randomUUID();
	try {
		queue.start();
		await recognition.upload(
			"owner",
			"main",
			new File(["jpg"], "capture.jpg", { type: "image/jpeg" }),
			id,
			"screen",
		);
		await waitFor(
			() => recognition.get("owner", id).captureSave === "unconfirmed",
		);
		connection = "second";
		await expect(recognition.resumeCaptureSave("owner", id)).rejects.toThrow(
			"capture_save_connection_changed",
		);
		expect(calls).toEqual([id]);
		connection = "first";
		const app = new Hono();
		registerObjectRecognition(app, recognition, "owner", {
			attach: async () => ({}),
			send: async () => ({}),
		});
		const response = await app.request(
			`/api/object-recognition/${id}/capture-save-resume`,
			{ method: "POST" },
		);
		expect(response.status).toBe(200);
		expect(
			((await response.json()) as { captureSave: string }).captureSave,
		).toBe("queued");
		await waitFor(() => recognition.get("owner", id).captureSave === "saved");
		expect(calls).toEqual([id, id]);
	} finally {
		await queue.close(500);
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("failure to persist the capture save state rolls back the queued job and recognition input", async () => {
	const dir = mkdtempSync(join(tmpdir(), "capture-transaction-"));
	const store = openStore(join(dir, "db"), [
		...queueMigrations,
		...imageMigrations,
		...recognitionMigrations,
	]);
	const queue = createQueue(store, { pollMs: 5 });
	const image = {} as ReturnType<typeof createImage>;
	let recognition!: ObjectRecognitionService;
	const enqueue = registerCaptureLibrary(
		queue,
		image,
		() => recognition,
		() => "fixture",
	);
	recognition = createObjectRecognition({
		store,
		queue,
		captureSaveInTransaction: enqueue,
		connection: () => ({
			revision: 1,
			baseUrl: "http://fixture.invalid",
			credential: "fixture",
		}),
	});
	const id = crypto.randomUUID();
	try {
		await store.write((db) =>
			db.exec(
				"CREATE TRIGGER fail_capture_status BEFORE UPDATE OF record_json ON object_recognition_inputs WHEN json_extract(NEW.record_json, '$.captureSave') = 'queued' BEGIN SELECT RAISE(ABORT, 'fixture_write_failure'); END",
			),
		);
		await expect(
			recognition.upload(
				"owner",
				"main",
				new File(["jpg"], "capture.jpg", { type: "image/jpeg" }),
				id,
				"camera",
			),
		).rejects.toThrow("fixture_write_failure");
		expect(() => recognition.get("owner", id)).toThrow("recognition_not_found");
		expect(queue.list({ subjectRef: id }).items).toHaveLength(0);
	} finally {
		await queue.close(500);
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a failed save-job registration is rolled back without losing recognition", async () => {
	const dir = mkdtempSync(join(tmpdir(), "capture-queue-failure-"));
	const store = openStore(join(dir, "db"), [
		...queueMigrations,
		...imageMigrations,
		...recognitionMigrations,
	]);
	const queue = createQueue(store, { pollMs: 5 });
	const image = {} as ReturnType<typeof createImage>;
	let recognition!: ObjectRecognitionService;
	const enqueue = registerCaptureLibrary(
		queue,
		image,
		() => recognition,
		() => "fixture",
	);
	recognition = createObjectRecognition({
		store,
		queue,
		captureSaveInTransaction: (db, input) => {
			enqueue(db, input);
			throw new Error("fixture_enqueue_failure");
		},
		connection: () => ({
			revision: 1,
			baseUrl: "http://fixture.invalid",
			credential: "fixture",
		}),
	});
	const id = crypto.randomUUID();
	try {
		const result = await recognition.upload(
			"owner",
			"main",
			new File(["jpg"], "capture.jpg", { type: "image/jpeg" }),
			id,
			"camera",
		);
		expect(result.state).toBe("queued");
		expect(result.captureSave).toBe("failed");
		expect(queue.list({ subjectRef: id }).items.map((job) => job.kind)).toEqual(
			["object-recognition.analyze"],
		);
	} finally {
		await queue.close(500);
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
