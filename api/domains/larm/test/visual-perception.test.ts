import { expect, test } from "bun:test";
import sharp from "sharp";
import { randomBytes } from "node:crypto";
import { createVisualPerception } from "..";
import {
	perceptionTask,
	perceptionOptions,
	perceptionResult,
} from "../contracts/visual-perception";
import {
	visualFetcher,
	visualImage,
	visualResult,
} from "./visual-perception.fixture";
const client = (f: ReturnType<typeof visualFetcher>) =>
	createVisualPerception({
		baseUrl: "http://127.0.0.1:9810",
		token: "control-secret",
		audience: "desktop",
		fetch: f.fetcher,
		pollMs: 1,
	});
test("a response missing execution metadata is a contract error, is not retried, and releases its connection", async () => {
	const f = visualFetcher({
		infer: async () => {
			const result = await visualResult();
			const execution: Record<string, unknown> = { ...result.execution };
			delete execution.decoderDtype;
			delete execution.visualTokens;
			return Response.json({ ...result, execution });
		},
	});
	await expect(
		client(f).perceive(
			await visualImage(),
			{ task: "describe", query: "説明" },
			AbortSignal.timeout(5000),
			async () => {},
		),
	).rejects.toThrow("invalid_visual_response");
	expect(
		f.requests.filter((r) => r.path === "/v1/vision/perceive"),
	).toHaveLength(1);
	expect(f.requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
});
test("a valid large response containing all eight alpha masks is not rejected by the HTTP read bound", async () => {
	const width = 1000,
		height = 500;
	const png = await sharp(randomBytes(width * height), {
		raw: { width, height, channels: 1 },
	})
		.toColourspace("b-w")
		.png()
		.toBuffer();
	expect(png.length * 8).toBeLessThanOrEqual(4194304);
	const large = await visualResult("matting");
	large.image = { width, height, orientation: "exif-normalized" };
	large.detections = Array.from({ length: 128 }, () => ({
		label: "あ".repeat(4096),
		text: "い".repeat(4096),
		box: [0, 0, width, height],
	}));
	large.masks = Array.from({ length: 8 }, (_, i) => ({
		detectionIndex: i,
		encoding: "png-base64",
		mode: "alpha",
		width,
		height,
		data: png.toString("base64"),
	}));
	expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(
		7 * 1024 * 1024,
	);
	const f = visualFetcher({ infer: async () => Response.json(large) });
	const bytes = await sharp({
		create: { width, height, channels: 3, background: "white" },
	})
		.png()
		.toBuffer();
	const v = await client(f).perceive(
		{ bytes, mime: "image/png", width, height },
		{ task: "matting", query: "対象" },
		AbortSignal.timeout(10000),
		async () => {},
	);
	expect(v.result.masks).toHaveLength(8);
	expect(v.releaseConfirmed).toBe(true);
});
test.each(perceptionTask.options)(
	"visual JSON contract %s discovers a selector, claims, infers once and releases",
	async (task) => {
		const f = visualFetcher();
		const phases: string[] = [];
		const v = await client(f).perceive(
			await visualImage(),
			{
				task,
				query:
					task === "detection" ? ["cup", "desk"] : task === "ocr" ? "" : "対象",
			},
			AbortSignal.timeout(5000),
			async (phase) => {
				phases.push(phase);
			},
		);
		expect(v.result.task).toBe(task);
		expect(v.releaseConfirmed).toBe(true);
		expect(phases.slice(0, 4)).toEqual([
			"connection",
			"running",
			"released",
			"lifecycle",
		]);
		const creation = f.requests.find(
			(r) => r.method === "POST" && r.path === "/v1/agent-connections",
		)!;
		expect(creation.body).toMatchObject({
			profile: "public-visual-choice",
			providers: ["fixture-vision"],
			audience: "desktop",
			ttlSeconds: 600,
			allowFallback: false,
			deploymentPolicy: "existing-only",
			expectedCatalogRevision: "revision",
		});
		expect(creation.headers.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
		const inference = f.requests.filter(
			(r) => r.path === "/v1/vision/perceive",
		);
		expect(inference).toHaveLength(1);
		expect(inference[0]!.headers.get("Authorization")).toBe(
			"Bearer provider-secret",
		);
		expect(inference[0]!.body?.model).toBe("fixture-visual-model");
		expect(inference[0]!.body?.image).toMatch(/^data:image\/png;base64,/);
		expect(f.requests.at(-1)?.headers.get("Authorization")).toBe(
			"Bearer control-secret",
		);
		expect(JSON.stringify(v)).not.toContain("secret");
	},
);
test.each([400, 401, 409, 413, 429, 503, 504])(
	"visual HTTP %i is distinguished, never retried, and releases",
	async (status) => {
		const f = visualFetcher({
			infer: async () => new Response(null, { status }),
		});
		await expect(
			client(f).perceive(
				await visualImage(),
				{ task: "describe", query: "説明" },
				AbortSignal.timeout(5000),
				async () => {},
			),
		).rejects.toThrow(`larm_http_${status}`);
		expect(
			f.requests.filter((r) => r.path === "/v1/vision/perceive"),
		).toHaveLength(1);
		expect(f.requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
	},
);
test("visual cancellation during inference releases using an independent signal", async () => {
	const abort = new AbortController();
	let entered!: () => void;
	const ready = new Promise<void>((r) => (entered = r));
	const f = visualFetcher({
		infer: async (_input, signal) => {
			entered();
			return new Promise((_resolve, reject) =>
				signal.addEventListener("abort", () => reject(signal.reason), {
					once: true,
				}),
			);
		},
	});
	const work = client(f).perceive(
		await visualImage(),
		{ task: "describe", query: "説明" },
		abort.signal,
		async () => {},
	);
	await ready;
	abort.abort();
	await expect(work).rejects.toThrow();
	expect(f.requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
});
test("late connection creation is collected and released after cancellation", async () => {
	const abort = new AbortController();
	const f = visualFetcher({
		create: async () => {
			abort.abort();
		},
	});
	await expect(
		client(f).perceive(
			await visualImage(),
			{ task: "describe", query: "説明" },
			abort.signal,
			async () => {},
		),
	).rejects.toThrow();
	expect(f.requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
	expect(
		f.requests.filter((r) => r.path === "/v1/vision/perceive"),
	).toHaveLength(0);
});
test("unconfirmed creation is recovered with the same idempotency key and client", async () => {
	let attempts = 0;
	const f = visualFetcher({
		create: async () => {
			if (attempts++ === 0) throw new TypeError("connection closed");
		},
	});
	await client(f).perceive(
		await visualImage(),
		{ task: "describe", query: "説明" },
		AbortSignal.timeout(5000),
		async () => {},
	);
	const creates = f.requests.filter((r) => r.path === "/v1/agent-connections");
	expect(creates).toHaveLength(2);
	expect(creates[0]!.headers.get("Idempotency-Key")).toBe(
		creates[1]!.headers.get("Idempotency-Key"),
	);
	expect(creates[0]!.body).toEqual(creates[1]!.body);
});
test("untrusted claim endpoint is rejected before a provider credential is sent", async () => {
	const f = visualFetcher({ wrongHost: true });
	await expect(
		client(f).perceive(
			await visualImage(),
			{ task: "describe", query: "説明" },
			AbortSignal.timeout(5000),
			async () => {},
		),
	).rejects.toThrow("larm_provider_host_mismatch");
	expect(
		f.requests.filter((r) => r.path === "/v1/vision/perceive"),
	).toHaveLength(0);
	expect(f.requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
});
test("release failure preserves the result and records an explicit warning", async () => {
	const f = visualFetcher({ releaseFail: true });
	const v = await client(f).perceive(
		await visualImage(),
		{ task: "describe", query: "説明" },
		AbortSignal.timeout(5000),
		async () => {},
	);
	expect(v.releaseConfirmed).toBe(false);
	expect(v.result.response).toContain("untrusted");
});
test("query, coordinates, mask references, and count are validated independently of raw tokens", async () => {
	expect(
		perceptionOptions.safeParse({ task: "referring", query: ["cup"] }).success,
	).toBe(false);
	expect(perceptionOptions.safeParse({ task: "ocr", query: "" }).success).toBe(
		true,
	);
	expect(
		perceptionOptions.safeParse({ task: "describe", query: "" }).success,
	).toBe(false);
	expect(
		perceptionOptions.safeParse({
			task: "detection",
			query: Array(33).fill("cup"),
		}).success,
	).toBe(false);
	const v = await visualResult("segmentation");
	v.masks[0]!.detectionIndex = 2;
	expect(perceptionResult.safeParse(v).success).toBe(false);
	v.masks[0]!.detectionIndex = 1;
	v.detections[0]!.box = [0, 0, 9, 6];
	expect(perceptionResult.safeParse(v).success).toBe(false);
	const f = visualFetcher({
		infer: async () => {
			const bad = await visualResult("segmentation");
			bad.masks[0]!.data = "invalid";
			return Response.json(bad);
		},
	});
	await expect(
		client(f).perceive(
			await visualImage(),
			{ task: "segmentation", query: "cup" },
			AbortSignal.timeout(5000),
			async () => {},
		),
	).rejects.toThrow("invalid_visual_mask");
	expect(f.requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
});
