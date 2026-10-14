import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { Hono } from "hono";
import { openStore } from "../../../infrastructure/sqlite";
import { createQueue, migrations as queueMigrations } from "../../queue";
import type { InferencePort } from "../../inference";
import type { Capabilities, Prepared } from "../../capabilities";
import { createOcr, migrations, registerOcr } from "..";

const close: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const f of close.splice(0)) await f();
});
async function until(check: () => boolean) {
	for (let i = 0; i < 200; i++) {
		if (check()) return;
		await Bun.sleep(10);
	}
	throw new Error("condition_not_reached");
}
const plan = {
	blocks: [
		{
			kind: "paragraph",
			text: "補正済み",
			evidence: { lineIndexes: [0] },
			uncertain: false,
		},
	],
	excludedLines: [],
};
function fixture(
	options: { video?: boolean; response?: unknown; wait?: Promise<void> } = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "ocr-correction-"));
	const store = openStore(join(dir, "db"), [...queueMigrations, ...migrations]);
	const queue = createQueue(store, {
		pollMs: 5,
		backoff: { baseMs: 10, maxMs: 10 },
	});
	const prepared = {
		package: {
			profileRevisionId: "profile:ocr.correct@1",
			requiredSkillRevisionIds: ["skill:ocr.correct@1"],
		},
		dependencies: [
			{ revisionId: "profile:ocr.correct@1", body: "画像に忠実に補正する" },
			{ revisionId: "skill:ocr.correct@1", body: "根拠を付けて返す" },
		],
	} as Prepared;
	const capabilities = {
		prepareActiveByIdInTransaction: () => prepared,
		validateInTransaction: () => {},
	} as unknown as Capabilities;
	let calls = 0;
	const inference = {
		captureUserControlInTransaction: () => crypto.randomUUID(),
		executeControl: async () => {
			calls++;
			await options.wait;
			return {
				requestId: crypto.randomUUID(),
				attemptId: crypto.randomUUID(),
				value: JSON.stringify(options.response ?? plan),
			};
		},
		acceptInTransaction: () => true,
		connect: async () => {},
		status: () => ({
			chatInput: {
				maxRequestBytes: 4_000_000,
				images: {
					mimeTypes: ["image/png"],
					maxBytes: 1_000_000,
					maxWidth: 1000,
					maxHeight: 1000,
					maxPixels: 1_000_000,
					maxAspectRatio: 100,
				},
			},
		}),
	} as unknown as InferencePort;
	const image = {
		kind: "image",
		model: "fixture",
		width: 100,
		height: 100,
		text: "誤字",
		lines: [
			{
				text: "誤字",
				confidence: 0.5,
				polygon: [
					[1, 1],
					[50, 1],
					[50, 20],
					[1, 20],
				],
			},
		],
	};
	const result = options.video
		? {
				kind: "video",
				model: "fixture",
				video: { width: 100, height: 100, durationSeconds: 1 },
				frames: [
					{ timestampSeconds: 0.2, text: image.text, lines: image.lines },
					{ timestampSeconds: 0.8, text: image.text, lines: image.lines },
				],
			}
		: image;
	const service = createOcr({
		store,
		queue,
		connection: () => ({
			revision: 1,
			baseUrl: "http://localhost:9/",
			credential: "test",
		}),
		fetcher: (async () => Response.json(result)) as unknown as typeof fetch,
		inference,
		capabilities: () => capabilities,
	});
	queue.start();
	close.push(async () => {
		await queue.close(100);
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return { service, store, calls: () => calls };
}
test("LLM correction preserves OCR, is idempotent, adopts explicitly, and enforces owner", async () => {
	const h = fixture();
	const png = await sharp({
		create: { width: 100, height: 100, channels: 3, background: "white" },
	})
		.png()
		.toBuffer();
	const sourceId = crypto.randomUUID();
	await h.service.upload(
		"alice",
		"main",
		new File([new Uint8Array(png)], "note.png", { type: "image/png" }),
		sourceId,
	);
	await until(() => h.service.get("alice", sourceId).state === "completed");
	const raw = h.service.get("alice", sourceId);
	const requestId = crypto.randomUUID();
	const input = {
		requestId,
		conversationId: "main",
		expectedRevision: raw.revision,
	};
	const first = await h.service.corrections!.create("alice", sourceId, input);
	expect(
		(await h.service.corrections!.create("alice", sourceId, input)).id,
	).toBe(first.id);
	await until(
		() => h.service.corrections!.get("alice", requestId).state === "completed",
	);
	expect(h.calls()).toBe(1);
	expect(h.service.get("alice", sourceId).result).toEqual(raw.result);
	expect(
		h.service.corrections!.list("alice", sourceId).preference.preferredId,
	).toBeNull();
	expect(
		await h.service.corrections!.prefer(
			"alice",
			sourceId,
			undefined,
			requestId,
			0,
		),
	).toEqual({ preferredId: requestId, revision: 1 });
	expect(
		h.service.corrections!.conversationText("alice", requestId).text,
	).toContain("補正済み");
	expect(() => h.service.corrections!.get("bob", requestId)).toThrow(
		"ocr_correction_not_found",
	);
	await expect(
		h.service.corrections!.create("bob", sourceId, {
			...input,
			requestId: crypto.randomUUID(),
		}),
	).rejects.toThrow("ocr_not_found");
	await h.service.remove("alice", sourceId);
	expect(() => h.service.corrections!.get("alice", requestId)).toThrow(
		"ocr_correction_not_found",
	);
});
test("selected video frame is extracted at its OCR timestamp", async () => {
	const h = fixture({ video: true });
	const encoded = Bun.spawn(
		[
			"ffmpeg",
			"-hide_banner",
			"-loglevel",
			"error",
			"-f",
			"lavfi",
			"-i",
			"color=c=white:s=100x100:r=10:d=1",
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
			"-movflags",
			"frag_keyframe+empty_moov",
			"-f",
			"mp4",
			"pipe:1",
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const bytes = new Uint8Array(
		await new Response(encoded.stdout).arrayBuffer(),
	);
	expect(await encoded.exited).toBe(0);
	const sourceId = crypto.randomUUID();
	await h.service.upload(
		"alice",
		"main",
		new File([bytes], "clip.mp4", { type: "video/mp4" }),
		sourceId,
	);
	await until(() => h.service.get("alice", sourceId).state === "completed");
	const requestId = crypto.randomUUID();
	await h.service.corrections!.create("alice", sourceId, {
		requestId,
		conversationId: "main",
		expectedRevision: h.service.get("alice", sourceId).revision,
		frameIndex: 1,
	});
	await until(() =>
		["completed", "failed"].includes(
			h.service.corrections!.get("alice", requestId).state,
		),
	);
	expect(h.service.corrections!.get("alice", requestId).state).toBe(
		"completed",
	);
	expect(h.service.corrections!.get("alice", requestId).frameIndex).toBe(1);
});
test("invalid evidence fails without changing the raw result", async () => {
	const h = fixture({
		response: {
			blocks: [
				{
					kind: "paragraph",
					text: "推測",
					evidence: { lineIndexes: [] },
					uncertain: false,
				},
			],
			excludedLines: [],
		},
	});
	const png = await sharp({
		create: { width: 100, height: 100, channels: 3, background: "white" },
	})
		.png()
		.toBuffer();
	const sourceId = crypto.randomUUID();
	await h.service.upload(
		"alice",
		"main",
		new File([new Uint8Array(png)], "note.png", { type: "image/png" }),
		sourceId,
	);
	await until(() => h.service.get("alice", sourceId).state === "completed");
	const raw = h.service.get("alice", sourceId).result;
	const requestId = crypto.randomUUID();
	await h.service.corrections!.create("alice", sourceId, {
		requestId,
		conversationId: "main",
		expectedRevision: h.service.get("alice", sourceId).revision,
	});
	await until(
		() => h.service.corrections!.get("alice", requestId).state === "failed",
	);
	expect(h.service.corrections!.get("alice", requestId).result).toBeNull();
	expect(h.service.get("alice", sourceId).result).toEqual(raw);
});
test("cancelling an in-flight correction discards its late reply", async () => {
	let release!: () => void;
	const wait = new Promise<void>((resolve) => {
		release = resolve;
	});
	const h = fixture({ wait });
	const png = await sharp({
		create: { width: 100, height: 100, channels: 3, background: "white" },
	})
		.png()
		.toBuffer();
	const sourceId = crypto.randomUUID();
	await h.service.upload(
		"alice",
		"main",
		new File([new Uint8Array(png)], "note.png", { type: "image/png" }),
		sourceId,
	);
	await until(() => h.service.get("alice", sourceId).state === "completed");
	const requestId = crypto.randomUUID();
	await h.service.corrections!.create("alice", sourceId, {
		requestId,
		conversationId: "main",
		expectedRevision: h.service.get("alice", sourceId).revision,
	});
	await until(
		() => h.service.corrections!.get("alice", requestId).state === "running",
	);
	await h.service.corrections!.cancel("alice", requestId);
	release();
	await until(
		() => h.service.corrections!.get("alice", requestId).state === "cancelled",
	);
	expect(h.service.corrections!.get("alice", requestId).result).toBeNull();
});
test("correction HTTP routes require the source conversation", async () => {
	const h = fixture();
	const app = new Hono();
	app.onError((error, c) =>
		c.json(
			{ error: error.message },
			error.message === "ocr_not_found" ? 404 : 500,
		),
	);
	registerOcr(app, h.service, "alice", async () => ({ ok: true }));
	const png = await sharp({
		create: { width: 100, height: 100, channels: 3, background: "white" },
	})
		.png()
		.toBuffer();
	const sourceId = crypto.randomUUID();
	await h.service.upload(
		"alice",
		"main",
		new File([new Uint8Array(png)], "note.png", { type: "image/png" }),
		sourceId,
	);
	await until(() => h.service.get("alice", sourceId).state === "completed");
	const path = `/api/ocr/${sourceId}/corrections`;
	expect((await app.request(`${path}?conversationId=other`)).status).toBe(404);
	const input = {
		requestId: crypto.randomUUID(),
		conversationId: "other",
		expectedRevision: h.service.get("alice", sourceId).revision,
	};
	expect(
		(
			await app.request(path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(input),
			})
		).status,
	).toBe(404);
	const valid = { ...input, conversationId: "main" };
	expect(
		(
			await app.request(path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(valid),
			})
		).status,
	).toBe(202);
	expect((await app.request(`${path}?conversationId=main`)).status).toBe(200);
	expect(
		(await app.request(`${path}/${input.requestId}?conversationId=other`))
			.status,
	).toBe(404);
});
