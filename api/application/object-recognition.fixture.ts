import type { LarmPort } from "../domains/larm";
import { imageFixture } from "./image.fixture";
export const recognitionFixtureImage = {
	kind: "image",
	model: "YOLO26n",
	width: 320,
	height: 240,
	objects: [
		{ classId: 41, label: "cup", confidence: 0.9, box: [30, 40, 90, 150] },
		{
			classId: 63,
			label: "laptop",
			confidence: 0.82,
			box: [130, 30, 280, 200],
		},
	],
};
export const recognitionFixtureVideo = {
	kind: "video",
	model: "YOLO26n",
	video: { width: 320, height: 240, durationSeconds: 2 },
	frames: [
		{ timestampSeconds: 0, objects: recognitionFixtureImage.objects },
		{ timestampSeconds: 0.5, objects: [] },
		{ timestampSeconds: 1, objects: [recognitionFixtureImage.objects[1]] },
	],
};
export function objectRecognitionFixture() {
	const calls: { path: string; method: string }[] = [];
	const jobs = new Map<
		string,
		{ reads: number; cancelled: boolean; hold: boolean }
	>();
	let next = 0;
	const fetcher = (async (url, init) => {
		const path = new URL(String(url)).pathname;
		const method = init?.method ?? "GET";
		calls.push({ path, method });
		if (path === "/api/analyze") {
			const form = init?.body as FormData;
			const file = form.get("file") as File;
			if (!file.type.startsWith("video/"))
				return Response.json(recognitionFixtureImage);
			const id = `video-${++next}`;
			jobs.set(id, {
				reads: 0,
				cancelled: false,
				hold: file.name === "cancel.webm",
			});
			return Response.json(
				{ id, statusUrl: `/api/jobs/${id}` },
				{ status: 202 },
			);
		}
		const id = path.split("/")[3]!;
		const job = jobs.get(id);
		if (!job) return Response.json({ error: "not_found" }, { status: 404 });
		if (path.endsWith("/cancel")) {
			job.cancelled = true;
			return Response.json({ status: "running" });
		}
		job.reads++;
		return Response.json(
			job.cancelled
				? { status: "cancelled" }
				: job.hold || job.reads < 2
					? {
							status: "running",
							progress: { processedFrames: 1, totalFrames: 3 },
						}
					: { status: "completed", result: recognitionFixtureVideo },
		);
	}) as typeof fetch;
	const contexts: string[] = [];
	const stages: string[] = [];
	const model: LarmPort = {
		status: () => ({ state: "ready", capabilities: ["llm"] }),
		connect: async () => {},
		close: async () => {},
		transcribe: async () => "",
		speak: async () => new Uint8Array(),
		answer: async (messages, _signal, options) => {
			contexts.push(JSON.stringify(messages));
			if (
				options?.tools?.some((t) => t.function.name === "object_recognition")
			) {
				stages.push("route");
				options.onToolCalls!([
					{
						id: "recognition",
						name: "object_recognition",
						arguments: JSON.stringify({
							request: messages.filter((m) => m.role === "user").at(-1)!
								.content,
						}),
					},
				]);
				return "";
			}
			if (
				messages[0]!.content.includes(
					"あなたはこのツールチェーンの操作担当です",
				)
			) {
				stages.push("command");
				return JSON.stringify({
					action: "invoke",
					tool: "object-recognition.manage",
					arguments: { action: "open", id: "", frameIndex: -1 },
				});
			}
			stages.push("answer");
			return messages.some((m) => m.content.includes('"recognitionResult"'))
				? "物体を調べる画面を開きました。"
				: "物体の観測結果を会話に取り込みました。";
		},
	};
	const png = async () =>
		await imageFixture()
			.gateway()
			.images.get("past-image", new AbortController().signal);
	const bytes = async () => {
		const gateway = imageFixture().gateway();
		const d = await png();
		return (
			await gateway.artifact(
				{ id: d.id, path: d.contentUrl, mime: d.mimeType },
				new AbortController().signal,
			)
		).bytes!;
	};
	return { fetcher, calls, model, contexts, stages, bytes };
}
