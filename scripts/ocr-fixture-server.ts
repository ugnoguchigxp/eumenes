import { harness } from "../api/application/toolchain/toolchain.fixture";
const image = {
	kind: "image",
	model: "ocr-fixture",
	width: 320,
	height: 240,
	text: "原文のまま\n二行目",
	lines: [
		{
			text: "原文のまま",
			confidence: 0.82,
			polygon: [
				[20, 30],
				[180, 30],
				[180, 65],
				[20, 65],
			],
		},
		{
			text: "二行目",
			confidence: 0.71,
			polygon: [
				[20, 80],
				[130, 80],
				[130, 115],
				[20, 115],
			],
		},
	],
};
const video = {
	kind: "video",
	model: "ocr-fixture",
	video: { width: 320, height: 240, durationSeconds: 2 },
	frames: [
		{ timestampSeconds: 0, text: "原文のまま", lines: [image.lines[0]] },
		{ timestampSeconds: 1, text: "二行目", lines: [image.lines[1]] },
	],
};
let next = 0;
const jobs = new Map<string, number>();
const h = await harness({
	settingsEnv: { LARM_API_TOKEN: "fixture-shared-ocr-token" },
	ocrFetcher: (async (url, init) => {
		const path = new URL(String(url)).pathname;
		if (path === "/api/analyze") {
			const body = init?.body;
			if (!(body instanceof FormData)) throw new Error("fixture_missing_file");
			const file = body.get("file") as File;
			if (file.type.startsWith("image/")) return Response.json(image);
			const id = `video-${++next}`;
			jobs.set(id, 0);
			return Response.json(
				{ id, statusUrl: `/api/jobs/${id}` },
				{ status: 202 },
			);
		}
		const id = path.split("/")[3]!;
		if (path.endsWith("/cancel")) {
			jobs.set(id, -1);
			return Response.json({ status: "running" });
		}
		const count = jobs.get(id);
		if (count === undefined)
			return Response.json({ error: "not_found" }, { status: 404 });
		if (count < 0) return Response.json({ status: "cancelled" });
		jobs.set(id, count + 1);
		return count === 0
			? Response.json({
					status: "running",
					progress: { processedFrames: 1, totalFrames: 2 },
				})
			: Response.json({ status: "completed", result: video });
	}) as typeof fetch,
});
await h.settings.configureOcr({
	expectedRevision: 0,
	baseUrl: "http://127.0.0.1:18794/",
});
const current = h.settings.get();
await h.settings.apply({
	requestId: crypto.randomUUID(),
	expectedRevision: current.revision,
	settings: { ...current, voice: { ...current.voice, autoSpeak: false } },
	keys: [],
});
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: Number(process.env.EUMENES_PORT),
	fetch: h.app.fetch,
});
const stop = async () => {
	await h.close();
	server.stop(true);
	process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
