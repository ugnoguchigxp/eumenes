import { afterEach, expect, test, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { prepareZXingModule, writeBarcode } from "zxing-wasm/writer";
import { Hono } from "hono";
import { openStore } from "../../../infrastructure/sqlite";
import { waitFor } from "../../../infrastructure/wait-for";
import { createQueue, migrations as queueMigrations } from "../../queue";
import { createOcr, migrations, registerOcr } from "..";
import { decodeQr } from "../service/qr-input";
import { errorStatus } from "../contracts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0)) await close();
});
prepareZXingModule({
	overrides: {
		wasmBinary: await Bun.file(
			new URL(import.meta.resolve("zxing-wasm/writer/zxing_writer.wasm")),
		).arrayBuffer(),
	},
});
const contents = [
	"https://example.com/qr?item=OCR-172",
	"検査済み 型番 AB-10O",
	"https://example.com/qr?item=OCR-172",
];
async function qrImage() {
	const layers = [];
	for (let i = 0; i < contents.length; i++) {
		const generated = await writeBarcode(contents[i]!, {
			format: "QRCode",
			scale: 5,
		});
		if (!generated.image) throw new Error("qr_fixture_failed");
		layers.push({
			input: Buffer.from(await generated.image.arrayBuffer()),
			left: i * 300 + 15,
			top: 30,
		});
	}
	return sharp({
		create: { width: 900, height: 300, channels: 3, background: "white" },
	})
		.composite(layers)
		.png()
		.toBuffer();
}
function fixture(decode?: typeof decodeQr, video = false) {
	const dir = mkdtempSync(join(tmpdir(), "ocr-qr-"));
	const store = openStore(join(dir, "db"), [...queueMigrations, ...migrations]);
	const queue = createQueue(store, { pollMs: 2 });
	const result = {
		kind: "image",
		model: "fixture",
		width: 900,
		height: 300,
		text: "",
		lines: [],
	};
	const ocr = createOcr({
		store,
		queue,
		qrDecoder: decode,
		connection: () => ({
			revision: 1,
			baseUrl: "http://localhost:9",
			credential: "test",
		}),
		fetcher: (async () =>
			Response.json(
				video
					? {
							kind: "video",
							model: "fixture",
							video: { width: 900, height: 300 },
							frames: [{ timestampSeconds: 0.2, text: "", lines: [] }],
						}
					: result,
			)) as unknown as typeof fetch,
	});
	queue.start();
	closers.push(async () => {
		await queue.close(100);
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return {
		ocr,
		store,
		queue,
		dir,
		async upload(bytes: Uint8Array) {
			const id = crypto.randomUUID();
			await ocr.upload(
				"alice",
				"main",
				new File([new Uint8Array(bytes)], video ? "qr.mp4" : "qr.png", {
					type: video ? "video/mp4" : "image/png",
				}),
				id,
			);
			await waitFor(() => ocr.get("alice", id).state === "completed");
			return ocr.get("alice", id);
		},
	};
}
test("real QR decoder returns Japanese, URLs and separate positions for identical payloads", async () => {
	const bytes = await qrImage(),
		started = performance.now();
	const items = await decodeQr(bytes, null, AbortSignal.timeout(10_000));
	expect(items.map((i) => i.text).sort()).toEqual([...contents].sort());
	expect(
		items.every(
			(i) =>
				i.polygon.length === 4 &&
				i.polygon.every(([x, y]) => x >= 0 && y >= 0 && x <= 900 && y <= 300),
		),
	).toBe(true);
	expect(new Set(items.map((i) => JSON.stringify(i.polygon))).size).toBe(3);
	console.log(
		JSON.stringify({
			case: "real-qr",
			width: 900,
			height: 300,
			count: items.length,
			durationMs: Math.round(performance.now() - started),
		}),
	);
	await expect(
		decodeQr(bytes, null, AbortSignal.timeout(10_000), {
			width: 100,
			height: 100,
		}),
	).rejects.toThrow("ocr_qr_dimensions_changed");
	const rotated = await sharp(bytes).rotate(90).png().toBuffer();
	expect(
		(await decodeQr(rotated, null, AbortSignal.timeout(10_000)))
			.map((i) => i.text)
			.sort(),
	).toEqual([...contents].sort());
	const blank = await sharp({
		create: { width: 100, height: 100, channels: 3, background: "white" },
	})
		.png()
		.toBuffer();
	expect(await decodeQr(blank, null, AbortSignal.timeout(10_000))).toEqual([]);
});
test("image completion automatically saves QR without changing OCR revision; receipt and owner checks persist", async () => {
	const h = fixture();
	const source = await h.upload(await qrImage());
	await waitFor(
		() => h.ocr.qr.latest("alice", source.id)?.state === "completed",
	);
	const qr = h.ocr.qr.latest("alice", source.id)!;
	expect(qr.items).toHaveLength(3);
	expect(h.ocr.get("alice", source.id).revision).toBe(source.revision);
	expect(
		await h.ocr.qr.create("alice", source.id, {
			requestId: qr.id,
			conversationId: "main",
			expectedRevision: source.revision,
		}),
	).toEqual(qr);
	await expect(
		h.ocr.qr.create("alice", source.id, {
			requestId: qr.id,
			conversationId: "wrong",
			expectedRevision: source.revision,
		}),
	).rejects.toThrow("request_conflict");
	expect(() => h.ocr.qr.get("bob", source.id, qr.id)).toThrow("ocr_not_found");
	expect(
		h.ocr.qr.conversationText("alice", source.id, qr.id, 0).text,
	).toContain(qr.items![0]!.text!);
	expect(h.ocr.qr.latest("alice", source.id)?.id).toBe(qr.id);
	await h.ocr.remove("alice", source.id);
	expect(() => h.ocr.qr.get("alice", source.id, qr.id)).toThrow(
		"ocr_not_found",
	);
});
test.each(["cancel", "delete"])(
	"%s rejects a non-cooperating decoder's late result",
	async (mode) => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let started = false;
		const h = fixture(async () => {
			started = true;
			await gate;
			return [
				{
					text: "late",
					contentType: "Text",
					polygon: [
						[0, 0],
						[10, 0],
						[10, 10],
						[0, 10],
					],
				},
			];
		});
		const source = await h.upload(new Uint8Array([1]));
		await waitFor(() => started);
		const qr = h.ocr.qr.latest("alice", source.id)!;
		if (mode === "cancel") await h.ocr.qr.cancel("alice", source.id, qr.id);
		else await h.ocr.remove("alice", source.id);
		release();
		await waitFor(() => h.queue.stats().lanes.interactive?.running === 0);
		if (mode === "cancel") {
			expect(h.ocr.qr.get("alice", source.id, qr.id).state).toBe("cancelled");
			expect(h.ocr.qr.get("alice", source.id, qr.id).items).toBeNull();
		} else expect(() => h.ocr.qr.get("alice", source.id, qr.id)).toThrow();
	},
);
test("QR HTTP routes reject a different conversation and bind conversation addition to stored QR", async () => {
	const h = fixture(async () => [
		{
			text: "確認済み",
			contentType: "Text",
			polygon: [
				[0, 0],
				[10, 0],
				[10, 10],
				[0, 10],
			],
		},
	]);
	const source = await h.upload(new Uint8Array([1]));
	await waitFor(
		() => h.ocr.qr.latest("alice", source.id)?.state === "completed",
	);
	const qr = h.ocr.qr.latest("alice", source.id)!;
	const added: string[] = [];
	const app = new Hono();
	app.onError((e, c) =>
		c.json(
			{ error: e.message },
			(errorStatus[e.message as keyof typeof errorStatus] ?? 400) as 400,
		),
	);
	registerOcr(app, h.ocr, "alice", async (text) => {
		added.push(text);
		return { ok: true };
	});
	expect(
		(await app.request(`/api/ocr/${source.id}/qr?conversationId=other`)).status,
	).toBe(404);
	expect(
		(await app.request(`/api/ocr/${source.id}/qr?conversationId=main`)).status,
	).toBe(200);
	const post = (conversationId: string) =>
		app.request(`/api/ocr/${source.id}/qr/${qr.id}/conversation`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				requestId: crypto.randomUUID(),
				conversationId,
				index: 0,
			}),
		});
	expect((await post("other")).status).toBe(404);
	expect(added).toHaveLength(0);
	expect((await post("main")).status).toBe(200);
	expect(added[0]).toContain("QRコードの復号結果");
	expect(added[0]).toContain("確認済み");
});
test("QR in a selected video frame uses the existing backend frame extraction", async () => {
	const h = fixture(undefined, true),
		image = await qrImage();
	const input = join(h.dir, "qr.png"),
		output = join(h.dir, "qr.mp4");
	await Bun.write(input, image);
	const proc = Bun.spawn(
		[
			"ffmpeg",
			"-hide_banner",
			"-loglevel",
			"error",
			"-loop",
			"1",
			"-i",
			input,
			"-t",
			"1",
			"-pix_fmt",
			"yuv420p",
			output,
		],
		{ stdout: "ignore", stderr: "ignore" },
	);
	expect(await proc.exited).toBe(0);
	const source = await h.upload(
		new Uint8Array(await Bun.file(output).arrayBuffer()),
	);
	expect(h.ocr.qr.latest("alice", source.id, 0)).toBeNull();
	const c = await h.ocr.qr.create("alice", source.id, {
		requestId: crypto.randomUUID(),
		conversationId: "main",
		expectedRevision: source.revision,
		frameIndex: 0,
	});
	await waitFor(
		() => h.ocr.qr.get("alice", source.id, c.id).state === "completed",
		{ timeout: 10_000 },
	);
	expect(
		h.ocr.qr
			.get("alice", source.id, c.id)
			.items!.map((i) => i.text)
			.sort(),
	).toEqual([...contents].sort());
	expect(h.ocr.qr.conversationText("alice", source.id, c.id, 0).text).toContain(
		"0.2秒",
	);
});

test("aborting QR decoding terminates its actual isolated WASM process", async () => {
	const bytes = await qrImage(),
		abort = new AbortController();
	let child: ReturnType<typeof Bun.spawn> | undefined;
	const spawn = Bun.spawn.bind(Bun);
	const spy = spyOn(Bun, "spawn").mockImplementation(((
		...args: Parameters<typeof Bun.spawn>
	) => {
		const result = spawn(...args);
		child = result;
		queueMicrotask(() => abort.abort());
		return result;
	}) as typeof Bun.spawn);
	try {
		await expect(decodeQr(bytes, null, abort.signal)).rejects.toThrow();
		expect(child).toBeDefined();
		expect(await child!.exited).not.toBe(0);
	} finally {
		spy.mockRestore();
		child?.kill();
	}
});
