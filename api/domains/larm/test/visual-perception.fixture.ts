import sharp from "sharp";
import type {
	PerceptionOptions,
	PerceptionResult,
} from "../contracts/visual-perception";
export const visualImage = async () => ({
	bytes: new Uint8Array(
		await sharp({
			create: { width: 8, height: 6, channels: 3, background: "white" },
		})
			.png()
			.toBuffer(),
	),
	mime: "image/png",
	width: 8,
	height: 6,
});
export async function visualResult(
	task: PerceptionOptions["task"] = "describe",
): Promise<PerceptionResult> {
	return {
		contractVersion: "larm.visual-perception.v1",
		model: "fixture-visual-model",
		modelRevision: "a".repeat(40),
		task,
		image: { width: 8, height: 6, orientation: "exif-normalized" },
		response: "<script>untrusted text</script>",
		detections:
			task === "describe"
				? []
				: [
						{ label: "same", box: [1, 1, 4, 4] },
						{ label: "same", box: [4, 1, 8, 6] },
					],
		masks:
			task === "segmentation" || task === "matting"
				? [
						{
							detectionIndex: 1,
							encoding: "png-base64",
							mode: task === "matting" ? "alpha" : "binary",
							width: 8,
							height: 6,
							data: (
								await sharp({
									create: {
										width: 8,
										height: 6,
										channels: 3,
										background: "white",
									},
								})
									.grayscale()
									.png()
									.toBuffer()
							).toString("base64"),
						},
					]
				: [],
		...(task === "count_box" ? { count: 2 } : {}),
		truncated: false,
		timings: {
			imageDecodeMs: 1,
			preprocessMs: 2,
			generationMs: 10,
			maskMs: 1,
			postprocessMs: 1,
			totalMs: 15,
		},
		execution: {
			device: "fixture",
			backend: "fixture",
			dtype: "fixture",
			decoderDtype: "fixture",
			outputTokens: 5,
			visualTokens: 10,
		},
	};
}
export function visualFetcher(
	options: {
		infer?: (
			input: Record<string, unknown>,
			signal: AbortSignal,
		) => Promise<Response>;
		create?: (signal: AbortSignal) => Promise<void>;
		releaseFail?: boolean;
		claim?: (attempt: number) => Response;
		connection?: (state: Record<string, unknown>) => Record<string, unknown>;
		snapshot?: () => Response | Promise<Response>;
		wrongHost?: boolean;
	} = {},
) {
	const requests: {
		path: string;
		method: string;
		headers: Headers;
		body: Record<string, unknown> | null;
		cache?: RequestCache;
	}[] = [];
	const provider = {
		name: "fixture-vision",
		capability: "vision.perception",
		protocol: "larm.visual-perception.v1",
		endpoint: "/v1/vision/perceive",
		model: "fixture-visual-model",
	};
	const profile = {
		id: "internal-vision-role",
		providers: [provider],
		services: [],
	};
	let polls = 0,
		claims = 0;
	let releasedAt: string | undefined;
	const fetcher = (async (input, init = {}) => {
		const url = new URL(String(input)),
			method = init.method ?? "GET",
			headers = new Headers(init.headers);
		const body = init.body
			? (JSON.parse(String(init.body)) as Record<string, unknown>)
			: null;
		requests.push({
			path: url.pathname,
			method,
			headers,
			body,
			cache: init.cache,
		});
		if (url.pathname === "/openapi.json")
			return Response.json({
				paths: {
					"/v3/agent-profiles": {
						get: {
							parameters: [
								{
									name: "profile",
									in: "query",
									schema: { enum: ["public-visual-choice"] },
								},
							],
						},
					},
				},
			});
		if (url.pathname === "/v3/agent-profiles")
			return Response.json({
				contractVersion: "agent-connection.v3",
				requestedProfile: url.searchParams.get("profile") ?? undefined,
				catalogRevision: "revision",
				audiences: ["desktop"],
				profiles: [profile],
			});
		const state = {
			id: "fixture-connection",
			allocationId: "fixture-allocation",
			releasedAt,
			agentProfile: profile.id,
			catalogRevision: "revision",
			status: polls++ ? "ready" : "pending",
			providers: [{ ...provider, claimable: true, readiness: "ready" }],
		};
		if (url.pathname === "/v1/agent-connections") {
			await options.create?.(init.signal!);
			return Response.json(options.connection?.(state) ?? state, {
				status: 202,
			});
		}
		if (url.pathname.endsWith("/claim"))
			return (
				options.claim?.(++claims) ??
				Response.json({
					id: state.id,
					status: "ready",
					expiresAt: new Date(Date.now() + 600000).toISOString(),
					providers: [
						{
							...provider,
							apiStyle: "larm-visual-perception",
							endpoint: `http://${options.wrongHost ? "192.168.1.99" : "127.0.0.1"}:9810/v1/vision/perceive`,
							credential: {
								type: "bearer",
								token: "provider-secret",
								expiresAt: new Date(Date.now() + 600000).toISOString(),
							},
						},
					],
				})
			);
		if (url.pathname === "/v1/vision/perceive")
			return options.infer
				? options.infer(body!, init.signal!)
				: Response.json(
						await visualResult(body!.task as PerceptionOptions["task"]),
					);
		if (method === "DELETE") {
			releasedAt = new Date().toISOString();
			return options.releaseFail
				? new Response(null, { status: 503 })
				: new Response(null, { status: 204 });
		}
		if (url.pathname === "/v1/allocations/fixture-allocation")
			return Response.json({
				id: "fixture-allocation",
				bindings: [
					{ capability: "vision.perception", runtime: "fixture-runtime" },
				],
			});
		if (url.pathname === "/state")
			return (
				options.snapshot?.() ??
				Response.json({
					online: true,
					runtimes: [
						{
							id: "fixture-runtime",
							status: "COLD",
							observedAt: new Date().toISOString(),
						},
					],
				})
			);
		if (url.pathname.endsWith(state.id))
			return Response.json(
				options.connection?.({
					...state,
					status: releasedAt ? "released" : "ready",
				}) ?? { ...state, status: releasedAt ? "released" : "ready" },
			);
		throw new Error("unexpected_fixture_route");
	}) as typeof fetch;
	return { fetcher, requests };
}
