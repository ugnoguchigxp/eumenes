import { expect, test } from "bun:test";
import { createLarmPlayground, findServiceTarget } from "..";

function fixture(options: { revision?: string; openapiStatus?: number } = {}) {
	const calls: { path: string; selector: string | null; method: string }[] = [];
	const aliases = ["public-visual", "public-audio"];
	const gateway = createLarmPlayground({
		baseUrl: "http://127.0.0.1:9999",
		token: "control-secret",
		profile: "saved-conversation",
		audience: "test",
		fetch: (async (input, init = {}) => {
			const url = new URL(String(input));
			const selector = url.searchParams.get("profile");
			calls.push({
				path: url.pathname,
				selector,
				method: init.method ?? "GET",
			});
			if (url.pathname === "/openapi.json")
				return Response.json(
					{
						paths: {
							"/v3/agent-profiles": {
								get: {
									parameters: [
										{ name: "profile", in: "query", schema: { enum: aliases } },
									],
								},
							},
						},
					},
					{ status: options.openapiStatus ?? 200 },
				);
			if (url.pathname !== "/v3/agent-profiles")
				throw new Error("unexpected_request");
			return Response.json({
				contractVersion: "agent-connection.v3",
				catalogRevision: aliases.includes(selector ?? "")
					? (options.revision ?? "revision-1")
					: "revision-1",
				requestedProfile: selector,
				profiles: ["image", "music"].map((kind, i) => ({
					id: `internal-${i}`,
					providers: [],
					services:
						selector === aliases[i]
							? [
									{
										name: `service-${i}`,
										model: `catalog-model-${i}`,
										protocol: `larm.${kind}-generation.v1`,
										capability: `media.${kind}.generate`,
										endpoint: `/v1/${kind === "image" ? "images" : "music"}/generations`,
									},
								]
							: [],
				})),
			});
		}) as typeof fetch,
	});
	return { gateway, calls };
}

test("public selectors discover services absent from internal profile IDs", async () => {
	const { gateway, calls } = fixture();
	const catalog = await gateway.catalog(AbortSignal.timeout(1000));
	for (const kind of ["image", "music"]) {
		const target = findServiceTarget(catalog.targets, `media.${kind}.generate`);
		expect(target?.kind).toBe(kind);
		expect(target?.model).toMatch(/^catalog-model-/);
	}
	expect(catalog.errors).toEqual([]);
	expect(calls.filter((c) => c.selector === "public-audio")).toHaveLength(1);
	expect(calls.every((c) => c.method === "GET")).toBe(true);
	expect(JSON.stringify(catalog)).not.toContain("control-secret");
});

test("public selectors cannot mix catalog revisions", async () => {
	const { gateway } = fixture({ revision: "revision-2" });
	await expect(gateway.catalog(AbortSignal.timeout(1000))).rejects.toThrow(
		"stale_catalog",
	);
});

test("optional OpenAPI absence preserves profile discovery", async () => {
	const { gateway, calls } = fixture({ openapiStatus: 404 });
	const catalog = await gateway.catalog(AbortSignal.timeout(1000));
	expect(catalog.errors).toEqual([]);
	expect(calls.some((c) => c.selector === "internal-0")).toBe(true);
	expect(calls.some((c) => c.selector === "public-audio")).toBe(false);
});

test("public selector discovery errors remain visible", async () => {
	const { gateway } = fixture({ openapiStatus: 503 });
	const catalog = await gateway.catalog(AbortSignal.timeout(1000));
	expect(catalog.errors).toContain("public-selectors: larm_http_503");
});
