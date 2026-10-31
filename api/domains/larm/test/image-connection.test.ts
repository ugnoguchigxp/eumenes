import type { TestInput } from "../contracts/playground";
import { expect, test } from "bun:test";
import { createLarmPlayground, type LarmTestTarget } from "..";

const target: LarmTestTarget = {
	id: "image-target",
	name: "image",
	model: "fixture-image",
	capability: "media.image.generate",
	protocol: "larm.image-generation.v1",
	kind: "image",
	mode: "service",
	endpoint: "/catalog-image",
	profile: "image-profile",
	selector: "public-image-selector",
	revision: "a".repeat(64),
	onDemand: true,
	primary: false,
};
function state() {
	return {
		id: "image-connection",
		agentProfile: target.profile,
		catalogRevision: target.revision,
		status: "ready",
		providers: [],
		services: [
			{
				name: target.name,
				capability: target.capability,
				protocol: target.protocol,
				model: target.model,
				url: "http://127.0.0.1:9999/acquired-image",
				endpoint: "/unused-image",
				description: "Generate one image using Control authentication",
			},
		],
	};
}
function fixture(
	override?: (path: string, init: RequestInit) => Response | undefined,
) {
	const calls: string[] = [];
	const gateway = createLarmPlayground({
		baseUrl: "http://127.0.0.1:9999",
		token: "fixture-control",
		audience: "same-host",
		pollMs: 1,
		fetch: (async (url, init = {}) => {
			const path = new URL(String(url)).pathname;
			calls.push(`${init.method ?? "GET"} ${path}`);
			const response = override?.(path, init);
			if (response) return response;
			if (path === "/v1/agent-connections") {
				const body = JSON.parse(String(init.body));
				expect(body.profile).toBe(target.selector);
				expect(body.expectedCatalogRevision).toBe(target.revision);
				expect(body.providers).toEqual(["llm"]);
				return Response.json(state(), { status: 201 });
			}
			if (path === "/v1/agent-connections/image-connection")
				return init.method === "DELETE"
					? new Response(null, { status: 204 })
					: Response.json(state());
			if (path === "/acquired-image")
				return Response.json({
					status: "succeeded",
					artifact: {
						id: "created-image",
						mimeType: "image/png",
						contentUrl: "/v1/image-artifacts/created-image/content",
					},
				});
			if (path === "/v1/image-artifacts/created-image/content")
				return new Response(
					Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]),
					{ headers: { "Content-Type": "image/png" } },
				);
			throw new Error(`unexpected_request:${path}`);
		}) as typeof fetch,
	});
	return {
		calls,
		execute: (
			signal = AbortSignal.timeout(1000),
			input: TestInput = { text: "fixture" },
		) => gateway.execute(target, input, signal, async () => {}),
	};
}
for (const status of ["pending", "probing", "ready"])
	test(`image uses the acquired on-demand service while provider status is ${status}`, async () => {
		const h = fixture((path) =>
			path === "/v1/agent-connections"
				? Response.json(
						{
							...state(),
							status,
							providers: [
								{ name: "llm", readiness: "waiting", claimable: false },
							],
						},
						{ status: status === "ready" ? 201 : 202 },
					)
				: undefined,
		);
		expect((await h.execute()).mime).toBe("image/png");
		expect(h.calls).toEqual([
			"POST /v1/agent-connections",
			"POST /acquired-image",
			"GET /v1/image-artifacts/created-image/content",
			"DELETE /v1/agent-connections/image-connection",
		]);
	});

for (const invalid of [
	"revision",
	"profile",
	"model",
	"protocol",
	"capability",
	"description",
	"missing-service",
	"failed",
	"expired",
	"released",
] as const)
	test(`image rejects ${invalid} connection without generating and releases it`, async () => {
		const h = fixture((path) => {
			if (path !== "/v1/agent-connections") return;
			const s = state();
			if (invalid === "revision") s.catalogRevision = "b".repeat(64);
			else if (invalid === "profile") s.agentProfile = "different-profile";
			else if (
				invalid === "failed" ||
				invalid === "expired" ||
				invalid === "released"
			)
				s.status = invalid;
			else if (invalid === "missing-service") s.services = [];
			else
				s.services[0]![invalid] = invalid === "description" ? " " : "different";
			return Response.json(s, { status: invalid === "failed" ? 503 : 201 });
		});
		await expect(h.execute()).rejects.toThrow(
			invalid === "revision" || invalid === "profile"
				? "invalid_connection_contract"
				: ["failed", "expired", "released"].includes(invalid)
					? "service_not_ready"
					: "invalid_service_binding",
		);
		expect(h.calls).toEqual([
			"POST /v1/agent-connections",
			"DELETE /v1/agent-connections/image-connection",
		]);
	});
test("image cancellation after connection creation collects and releases the late ID without generating", async () => {
	const abort = new AbortController();
	const h = fixture((path) => {
		if (path !== "/v1/agent-connections") return;
		abort.abort();
		return Response.json(state(), { status: 201 });
	});
	await expect(h.execute(abort.signal)).rejects.toThrow();
	expect(h.calls).toEqual([
		"POST /v1/agent-connections",
		"DELETE /v1/agent-connections/image-connection",
	]);
});
for (const status of [500, 503])
	test(`image HTTP${status} releases the connection without waiting or resubmitting`, async () => {
		const h = fixture((path) =>
			path === "/acquired-image" ? new Response(null, { status }) : undefined,
		);
		await expect(h.execute()).rejects.toThrow(`larm_http_${status}`);
		expect(h.calls).toEqual([
			"POST /v1/agent-connections",
			"POST /acquired-image",
			"DELETE /v1/agent-connections/image-connection",
		]);
	});

for (const model of [undefined, "qwen-image-2.1-turbo", "flux-3-image-klein"])
	test(`image request preserves explicit model ${model ?? "omitted"} and omits steps`, async () => {
		const h = fixture((path, init) => {
			if (path !== "/acquired-image") return;
			const body = JSON.parse(String(init.body));
			expect(body).toEqual({
				prompt: "猫",
				...(model ? { model } : {}),
				width: 768,
				height: 768,
				seed: 42,
				format: "webp",
			});
			expect(new Headers(init.headers).get("authorization")).toBe(
				"Bearer fixture-control",
			);
		});
		await h.execute(undefined, {
			text: "猫",
			model,
			width: 768,
			height: 768,
			seed: 42,
			format: "webp",
		});
		expect(h.calls.filter((c) => c === "POST /acquired-image")).toHaveLength(1);
	});
for (const [status, errorCode] of [
	[503, "image_model_unavailable"],
	[409, "media_variant_busy"],
	[400, "invalid_model"],
	[400, "invalid_steps"],
] as const)
	test(`image ${errorCode} is reported without switching model or resubmitting`, async () => {
		const h = fixture((path, init) => {
			if (path !== "/acquired-image") return;
			expect(JSON.parse(String(init.body)).model).toBe("flux-3-image-klein");
			return Response.json(
				{ error: { code: errorCode, message: "private response" } },
				{ status },
			);
		});
		await expect(
			h.execute(undefined, { text: "猫", model: "flux-3-image-klein" }),
		).rejects.toThrow(status === 400 ? "larm_http_400" : errorCode);
		expect(h.calls).toEqual([
			"POST /v1/agent-connections",
			"POST /acquired-image",
			"DELETE /v1/agent-connections/image-connection",
		]);
	});
test("image supports artifacts array and reports the actual selected model", async () => {
	const h = fixture((path) =>
		path === "/acquired-image"
			? Response.json({
					status: "succeeded",
					artifacts: [
						{
							id: "created-image",
							mimeType: "image/png",
							contentUrl: "/v1/image-artifacts/created-image/content",
							model: "flux-3-image-klein",
						},
					],
				})
			: undefined,
	);
	expect(
		(await h.execute(undefined, { text: "猫", model: "flux-3-image-klein" }))
			.actualModel,
	).toBe("flux-3-image-klein");
});
test("image transport failure never resubmits or fetches an unconfirmed result", async () => {
	const h = fixture((path) => {
		if (path === "/acquired-image") throw new TypeError("network");
	});
	await expect(
		h.execute(undefined, { text: "猫", model: "flux-3-image-klein" }),
	).rejects.toThrow("generation_unknown");
	expect(h.calls).toEqual([
		"POST /v1/agent-connections",
		"POST /acquired-image",
		"DELETE /v1/agent-connections/image-connection",
	]);
});
