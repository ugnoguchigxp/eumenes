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
import {
	correctionPlainText,
	correctionResult,
	validateCorrection,
} from "../contracts";
import { waitFor as until } from "../../../infrastructure/wait-for";

const close: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const f of close.splice(0)) await f();
});
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
	options: {
		video?: boolean;
		response?: unknown;
		wait?: Promise<void>;
		mimeTypes?: Array<"image/jpeg" | "image/png" | "image/bmp">;
		maxImageBytes?: number;
		maxRequestBytes?: number;
		editPlan?: boolean;
	} = {},
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
	if (options.editPlan) {
		prepared.package.profileRevisionId = "profile:ocr.correct@3";
		prepared.package.requiredSkillRevisionIds = ["skill:ocr.correct@3"];
		prepared.dependencies = [
			{ revisionId: "profile:ocr.correct@3", body: "保持箇所と訂正を指定する" },
			{ revisionId: "skill:ocr.correct@3", body: "元文へ編集を適用する" },
		] as Prepared["dependencies"];
	}
	const requestedPackages: string[] = [];
	const capabilities = {
		prepareActiveByIdInTransaction: (
			_db: unknown,
			_run: unknown,
			id: string,
		) => {
			requestedPackages.push(id);
			return prepared;
		},
		validateInTransaction: () => {},
	} as unknown as Capabilities;
	let calls = 0;
	let systemPrompt = "";
	let sentImage: { mime: string; bytes: Uint8Array } | undefined;
	const cancelledRequests: string[] = [];
	const inference = {
		captureUserControlInTransaction: () => crypto.randomUUID(),
		cancelRequestsInTransaction: (_db: unknown, ids: string[]) => {
			cancelledRequests.push(...ids);
		},
		executeControl: async (
			_id: string,
			messages: {
				role: string;
				content: string;
				images?: Array<{ mime: string; bytes: Uint8Array }>;
			}[],
		) => {
			calls++;
			systemPrompt =
				messages.find((message) => message.role === "system")?.content ?? "";
			sentImage = messages.find((message) => message.role === "user")
				?.images?.[0];
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
				maxRequestBytes: options.maxRequestBytes ?? 4_000_000,
				images: {
					mimeTypes: options.mimeTypes ?? ["image/png"],
					maxBytes: options.maxImageBytes ?? 1_000_000,
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
	return {
		service,
		store,
		calls: () => calls,
		systemPrompt: () => systemPrompt,
		sentImage: () => sentImage,
		cancelledRequests,
		requestedPackages,
	};
}
test("new edit revision completes through the queue and exports the existing public result", async () => {
	const h = fixture({
		editPlan: true,
		response: {
			protectedSpans: [],
			edits: [{ line: 0, wholeLine: true, after: "訂正" }],
			blocks: [{ kind: "paragraph", parts: [{ line: 0 }], uncertain: false }],
			excludedLines: [],
		},
	});
	const png = await sharp({
		create: { width: 100, height: 100, channels: 3, background: "white" },
	})
		.png()
		.toBuffer();
	const id = crypto.randomUUID();
	await h.service.upload(
		"alice",
		"main",
		new File([new Uint8Array(png)], "note.png", { type: "image/png" }),
		id,
	);
	await until(() => h.service.get("alice", id).state === "completed");
	const source = h.service.get("alice", id),
		candidate = crypto.randomUUID();
	await h.service.corrections!.create("alice", id, {
		requestId: candidate,
		conversationId: "main",
		expectedRevision: source.revision,
	});
	await until(
		() => h.service.corrections!.get("alice", candidate).state === "completed",
	);
	expect(h.requestedPackages).toEqual(["package:ocr.correct@3"]);
	expect(h.systemPrompt()).toContain('"protectedSpans"');
	expect(h.calls()).toBe(1);
	expect(
		correctionPlainText(h.service.corrections!.get("alice", candidate).result!),
	).toBe("訂正");
	expect(
		h.service.corrections!.conversationText("alice", candidate).text,
	).toContain("訂正");
	expect(h.service.get("alice", id).result).toEqual(source.result);
	const app = new Hono();
	registerOcr(app, h.service, "alice", async () => ({ ok: true }));
	const read = await app.request(
		`/api/ocr/${id}/corrections/${candidate}?conversationId=main`,
	);
	expect(read.status).toBe(200);
	expect(JSON.stringify(await read.json())).toContain("訂正");
});
test("invalid edit plans fail atomically and never retry with the legacy contract", async () => {
	const h = fixture({
		editPlan: true,
		response: {
			protectedSpans: [{ line: 0, text: "誤字" }],
			edits: [{ line: 0, before: "誤字", after: "型番変更" }],
			blocks: [{ kind: "paragraph", parts: [{ line: 0 }], uncertain: false }],
			excludedLines: [],
		},
	});
	const png = await sharp({
		create: { width: 100, height: 100, channels: 3, background: "white" },
	})
		.png()
		.toBuffer();
	const id = crypto.randomUUID();
	await h.service.upload(
		"alice",
		"main",
		new File([new Uint8Array(png)], "note.png", { type: "image/png" }),
		id,
	);
	await until(() => h.service.get("alice", id).state === "completed");
	const source = h.service.get("alice", id),
		candidate = crypto.randomUUID();
	await h.service.corrections!.create("alice", id, {
		requestId: candidate,
		conversationId: "main",
		expectedRevision: source.revision,
	});
	await until(
		() => h.service.corrections!.get("alice", candidate).state === "failed",
	);
	expect(h.service.corrections!.get("alice", candidate).errorCode).toBe(
		"ocr_correction_protected_edit",
	);
	expect(h.service.corrections!.get("alice", candidate).result).toBeNull();
	expect(h.calls()).toBe(1);
	expect(h.cancelledRequests).toHaveLength(1);
	expect(h.service.get("alice", id).result).toEqual(source.result);
});
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
	expect(h.systemPrompt()).toContain("OUTPUT_SCHEMA=");
	expect(h.systemPrompt()).toContain('"blocks"');
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
test("a second correction on the same frame reports busy", async () => {
	let release!: () => void;
	const wait = new Promise<void>((resolve) => {
		release = resolve;
	});
	const h = fixture({
		wait,
		editPlan: true,
		response: {
			protectedSpans: [],
			edits: [],
			blocks: [{ kind: "paragraph", parts: [{ line: 0 }], uncertain: false }],
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
	const expectedRevision = h.service.get("alice", sourceId).revision;
	const firstId = crypto.randomUUID();
	await h.service.corrections!.create("alice", sourceId, {
		requestId: firstId,
		conversationId: "main",
		expectedRevision,
	});
	await expect(
		h.service.corrections!.create("alice", sourceId, {
			requestId: crypto.randomUUID(),
			conversationId: "main",
			expectedRevision,
		}),
	).rejects.toThrow("ocr_correction_busy");
	await h.service.corrections!.cancel("alice", firstId);
	release();
});
test("vision input follows the connected service's JPEG or BMP contract", async () => {
	const png = await sharp({
		create: { width: 100, height: 100, channels: 3, background: "white" },
	})
		.png()
		.toBuffer();
	for (const mime of ["image/jpeg", "image/bmp"] as const) {
		const h = fixture({ mimeTypes: [mime] });
		const sourceId = crypto.randomUUID();
		await h.service.upload(
			"alice",
			"main",
			new File([new Uint8Array(png)], "note.png", { type: "image/png" }),
			sourceId,
		);
		await until(() => h.service.get("alice", sourceId).state === "completed");
		const candidateId = crypto.randomUUID();
		await h.service.corrections!.create("alice", sourceId, {
			requestId: candidateId,
			conversationId: "main",
			expectedRevision: h.service.get("alice", sourceId).revision,
		});
		await until(
			() =>
				h.service.corrections!.get("alice", candidateId).state === "completed",
		);
		const image = h.sentImage();
		expect(image?.mime).toBe(mime);
		expect(Buffer.from(image!.bytes).subarray(0, 2).toString("hex")).toBe(
			mime === "image/jpeg" ? "ffd8" : "424d",
		);
	}
});
test("vision input uses JPEG when PNG exceeds image or full-request limits", async () => {
	const pixels = crypto.getRandomValues(new Uint8Array(100 * 100 * 3));
	const png = await sharp(pixels, {
		raw: { width: 100, height: 100, channels: 3 },
	})
		.png()
		.toBuffer();
	for (const limits of [
		{ maxImageBytes: 20_000 },
		{ maxRequestBytes: 45_000 },
	]) {
		const h = fixture({ mimeTypes: ["image/png", "image/jpeg"], ...limits });
		const sourceId = crypto.randomUUID();
		await h.service.upload(
			"alice",
			"main",
			new File([new Uint8Array(png)], "note.png", { type: "image/png" }),
			sourceId,
		);
		await until(() => h.service.get("alice", sourceId).state === "completed");
		const candidateId = crypto.randomUUID();
		await h.service.corrections!.create("alice", sourceId, {
			requestId: candidateId,
			conversationId: "main",
			expectedRevision: h.service.get("alice", sourceId).revision,
		});
		await until(
			() =>
				h.service.corrections!.get("alice", candidateId).state === "completed",
		);
		expect(h.sentImage()?.mime).toBe("image/jpeg");
		expect(h.sentImage()!.bytes.length).toBeLessThanOrEqual(
			limits.maxImageBytes ?? 20_000,
		);
	}
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
	expect(
		h.service.corrections!.conversationText("alice", requestId).text,
	).toContain("フレーム時刻: 0.8秒");
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
	expect(h.cancelledRequests).toHaveLength(1);
});
test("conversation export retains table uncertainty and excluded OCR lines", async () => {
	const h = fixture({
		response: {
			blocks: [
				{
					kind: "table",
					rows: 1,
					columns: 1,
					evidence: { lineIndexes: [], region: [0, 0, 100, 100] },
					uncertain: true,
					uncertainty: "罫線が薄い",
					cells: [
						{
							row: 0,
							column: 0,
							rowSpan: 1,
							columnSpan: 1,
							text: "補正後",
							evidence: { lineIndexes: [], region: [0, 0, 50, 20] },
							uncertain: false,
						},
					],
				},
			],
			excludedLines: [{ index: 0, reason: "重複" }],
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
	const candidateId = crypto.randomUUID();
	await h.service.corrections!.create("alice", sourceId, {
		requestId: candidateId,
		conversationId: "main",
		expectedRevision: h.service.get("alice", sourceId).revision,
	});
	await until(
		() =>
			h.service.corrections!.get("alice", candidateId).state === "completed",
	);
	const text = h.service.corrections!.conversationText(
		"alice",
		candidateId,
	).text;
	expect(text).toContain("判読困難箇所: 罫線が薄い");
	expect(text).toContain("補正案から除外したOCR行: 1行目: 重複");
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
test("table cells keep their grid spans and cannot overlap", () => {
	const cell = {
		row: 0,
		column: 0,
		rowSpan: 2,
		columnSpan: 2,
		text: "見出し",
		evidence: { lineIndexes: [0] },
		uncertain: false,
	};
	const value = correctionResult.parse({
		blocks: [
			{
				kind: "table",
				rows: 2,
				columns: 3,
				cells: [
					cell,
					{ ...cell, row: 0, column: 2, rowSpan: 1, columnSpan: 1, text: "A" },
					{ ...cell, row: 1, column: 2, rowSpan: 1, columnSpan: 1, text: "B" },
				],
				evidence: { lineIndexes: [0] },
				uncertain: false,
			},
		],
		excludedLines: [],
	});
	expect(() => validateCorrection(value, 1, 100, 100)).not.toThrow();
	expect(correctionPlainText(value)).toBe("見出し\t\tA\n\t\tB");
	const overlapping = correctionResult.parse({
		blocks: [
			{
				kind: "table",
				rows: 2,
				columns: 3,
				cells: [cell, { ...cell, column: 1, columnSpan: 1 }],
				evidence: { lineIndexes: [0] },
				uncertain: false,
			},
		],
		excludedLines: [],
	});
	expect(() => validateCorrection(overlapping, 1, 100, 100)).toThrow(
		"ocr_correction_invalid_table",
	);
});
test("frame extraction cannot be redirected to local files by a crafted container", async () => {
	const { imageForInput } = await import("../service/correction-shared");
	const playlist = new TextEncoder().encode(
		"#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nfile:///etc/hosts\n#EXT-X-ENDLIST\n",
	);
	await expect(
		imageForInput(
			playlist,
			0,
			new AbortController().signal,
			["image/png"],
			1_000_000,
		),
	).rejects.toThrow();
});
