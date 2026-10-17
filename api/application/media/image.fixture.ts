import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { createLarmPlayground, type LarmPort } from "../../domains/larm";
export const imageQuestion = "夕焼けの海のイラストを121×177のPNGで生成して";
export const imageTestPlan = {
	action: "generate",
	title: "夕焼けの海",
	description: "柔らかな色彩の海景。",
	prompt: "A calm ocean at sunset, warm amber sky, painterly illustration",
	width: 121,
	height: 177,
	format: "png",
	seed: 42,
};
function crc(bytes: Uint8Array) {
	let c = 0xffffffff;
	for (const b of bytes) {
		c ^= b;
		for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
	}
	return (c ^ 0xffffffff) >>> 0;
}
export function png(width: number, height: number) {
	const chunk = (name: string, data: Uint8Array) => {
		const body = Buffer.concat([Buffer.from(name), data]);
		const a = Buffer.alloc(8);
		a.writeUInt32BE(data.length, 0);
		a.writeUInt32BE(crc(body), 4);
		return Buffer.concat([a.subarray(0, 4), body, a.subarray(4)]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 2;
	const pixels = Buffer.alloc((width * 3 + 1) * height);
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++) {
			const i = y * (width * 3 + 1) + 1 + x * 3;
			pixels[i] = Math.round(235 - (y / height) * 150);
			pixels[i + 1] = Math.round(130 + (x / width) * 45);
			pixels[i + 2] = Math.round(110 + (y / height) * 90);
		}
	return new Uint8Array(
		Buffer.concat([
			Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
			chunk("IHDR", header),
			chunk("IDAT", deflateSync(pixels)),
			chunk("IEND", Buffer.alloc(0)),
		]),
	);
}
export function imageFixture(
	mode:
		| "success"
		| "failure"
		| "invalid-plan"
		| "library"
		| "studio"
		| "fetch-failure" = "success",
	gate?: Promise<void>,
) {
	const requests: Array<{
		method: string;
		path: string;
		body: unknown;
		auth: string | null;
	}> = [];
	const stages: string[] = [];
	let deleteFailure = 0;
	const images = new Map<
		string,
		{ metadata: ReturnType<typeof descriptor>; bytes: Uint8Array }
	>();
	function descriptor(
		id: string,
		width: number,
		height: number,
		bytes: Uint8Array,
	) {
		return {
			id,
			width,
			height,
			format: "png" as const,
			mimeType: "image/png" as const,
			createdAt: "2026-10-13T00:00:00Z",
			hasAlpha: false,
			bytes: bytes.length,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			model: "fixture-image",
			contentUrl: `/v1/image-artifacts/${id}/content`,
		};
	}
	const past = png(320, 240);
	images.set("past-image", {
		metadata: descriptor("past-image", 320, 240, past),
		bytes: past,
	});
	const imageService = {
		name: "image",
		capability: "media.image.generate",
		protocol: "larm.image-generation.v1",
		endpoint: "/v1/images/generations",
		url: "/v1/images/generations",
		model: "fixture-image",
		description:
			"Image service, synchronous POST, exact dimensions, PNG/WebP; no reference editing",
		startupPolicy: { minWarmInstances: 0 },
	};
	const gateway = () =>
		createLarmPlayground({
			baseUrl: "http://127.0.0.1:9999",
			token: "fixture-image-secret",
			profile: "fixture",
			audience: "test",
			fetch: (async (url, init = {}) => {
				const u = new URL(String(url));
				const path = u.pathname;
				const body =
					typeof init.body === "string" ? JSON.parse(init.body) : null;
				requests.push({
					method: init.method ?? "GET",
					path,
					body,
					auth: new Headers(init.headers).get("authorization"),
				});
				if (path === "/v3/agent-profiles")
					return Response.json({
						contractVersion: "agent-connection.v3",
						requestedProfile: u.searchParams.get("profile") ?? "",
						catalogRevision: "a".repeat(64),
						profiles: [
							{
								id: "image-profile",
								providers: [],
								services: [imageService],
							},
						],
					});
				if (path === "/v1/agent-connections")
					return Response.json(
						{
							id: "image-connection",
							agentProfile: "image-profile",
							catalogRevision: "a".repeat(64),
							status: "ready",
							providers: [],
							services: [imageService],
						},
						{ status: 201 },
					);
				if (
					path === "/v1/agent-connections/image-connection" &&
					init.method === "DELETE"
				)
					return new Response(null, { status: 204 });
				if (path === "/v1/images/generations") {
					if (gate) await gate;
					if (mode === "failure") return new Response(null, { status: 503 });
					const bytes = png(body.width, body.height);
					const metadata = descriptor(
						"new-image",
						body.width,
						body.height,
						bytes,
					);
					images.set(metadata.id, { metadata, bytes });
					return Response.json({ status: "succeeded", artifact: metadata });
				}
				if (path === "/v1/image-artifacts")
					return Response.json({
						images: [...images.values()].map((a) => a.metadata),
						totalBytes: [...images.values()].reduce(
							(sum, a) => sum + a.bytes.length,
							0,
						),
						maxBytes: 100000000,
						targetBytes: 80000000,
					});
				const id = path.split("/")[3]!;
				const a = images.get(id);
				if (!a) return new Response(null, { status: 404 });
				if (init.method === "DELETE") {
					if (deleteFailure)
						return new Response(null, { status: deleteFailure });
					images.delete(id);
					return Response.json({ id, deleted: true });
				}
				if (path.endsWith("/content"))
					return mode === "fetch-failure" && id === "new-image"
						? new Response(null, { status: 503 })
						: new Response(new Uint8Array(a.bytes), {
								headers: { "Content-Type": "image/png" },
							});
				return Response.json(a.metadata);
			}) as typeof fetch,
		});
	const model: LarmPort = {
		status: () => ({ state: "ready", capabilities: ["llm"] }),
		connect: async () => {},
		close: async () => {},
		transcribe: async () => "",
		speak: async () => new Uint8Array(),
		answer: async (messages, _signal, options) => {
			if (options?.tools?.[0]?.function.name === "find_toolchain") {
				options.onToolCalls!([
					{ id: "discovery", name: "find_toolchain", arguments: "{}" },
				]);
				return "";
			}
			if (options?.tools?.length) {
				stages.push("route");
				options.onToolCalls!([
					{
						id: "image",
						name: "image",
						arguments: JSON.stringify({
							announcement: "準備します。",
							request: messages.filter((m) => m.role === "user").at(-1)!
								.content,
						}),
					},
				]);
				return "";
			}
			if (messages[0]!.content.includes("OUTPUT_SCHEMA=")) {
				stages.push("plan");
				if (mode === "invalid-plan")
					return JSON.stringify({ ...imageTestPlan, width: 99 });
				const request = JSON.parse(messages[1]!.content);
				let values = {};
				try {
					values = JSON.parse(
						request.question.slice(request.question.indexOf("\n\n") + 2),
					);
				} catch {}
				return JSON.stringify({
					...imageTestPlan,
					...values,
					...(mode === "library" || mode === "studio"
						? { action: mode, prompt: "" }
						: {}),
				});
			}
			stages.push("answer");
			const result = JSON.parse(
				messages.find((m) => m.content.startsWith('{"imageResult":'))!.content,
			).imageResult;
			return result.state === "completed"
				? result.action === "generate"
					? "画像ができました。"
					: "画像の画面を開きました。"
				: "画像を生成できませんでした。";
		},
	};
	return {
		model,
		gateway,
		requests,
		stages,
		images,
		setDeleteFailure: (status: number) => {
			deleteFailure = status;
		},
	};
}
