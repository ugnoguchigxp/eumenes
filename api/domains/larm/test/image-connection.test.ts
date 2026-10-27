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
		execute: (signal = AbortSignal.timeout(1000)) =>
			gateway.execute(target, { text: "fixture" }, signal, async () => {}),
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
