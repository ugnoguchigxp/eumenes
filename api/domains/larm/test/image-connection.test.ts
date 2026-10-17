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
				expect(body).not.toHaveProperty("providers");
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
		execute: (signal = AbortSignal.timeout(1000)) =>
			gateway.execute(target, { text: "fixture" }, signal, async () => {}),
	};
}
test("image waits for connection readiness before using the acquired service and releases after content", async () => {
	const h = fixture((path, init) => {
		if (path === "/v1/agent-connections")
			return Response.json({ ...state(), status: "pending" }, { status: 202 });
		if (
			path === "/v1/agent-connections/image-connection" &&
			init.method !== "DELETE"
		) {
			expect(h.calls).not.toContain("POST /acquired-image");
			return Response.json(state());
		}
	});
	expect((await h.execute()).mime).toBe("image/png");
	expect(h.calls).toEqual([
		"POST /v1/agent-connections",
		"GET /v1/agent-connections/image-connection",
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
] as const)
	test(`image rejects ${invalid} connection without generating and releases it`, async () => {
		const h = fixture((path) => {
			if (path !== "/v1/agent-connections") return;
			const s = state();
			if (invalid === "revision") s.catalogRevision = "b".repeat(64);
			else if (invalid === "profile") s.agentProfile = "different-profile";
			else if (invalid === "failed") s.status = "failed";
			else if (invalid === "missing-service") s.services = [];
			else
				s.services[0]![invalid] = invalid === "description" ? " " : "different";
			return Response.json(s, { status: invalid === "failed" ? 503 : 201 });
		});
		await expect(h.execute()).rejects.toThrow(
			invalid === "revision" || invalid === "profile"
				? "invalid_connection_contract"
				: invalid === "failed"
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
test("image generation failure releases the connection without resubmitting", async () => {
	const h = fixture((path) =>
		path === "/acquired-image"
			? new Response(null, { status: 503 })
			: undefined,
	);
	await expect(h.execute()).rejects.toThrow("larm_http_503");
	expect(h.calls).toEqual([
		"POST /v1/agent-connections",
		"POST /acquired-image",
		"DELETE /v1/agent-connections/image-connection",
	]);
});
