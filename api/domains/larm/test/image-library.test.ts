import { expect, test } from "bun:test";
import { createLarmPlayground } from "..";
const metadata = {
	id: "old",
	createdAt: "2026-10-13T00:00:00Z",
	format: "png",
	mimeType: "image/png",
	width: 121,
	height: 177,
	hasAlpha: false,
	bytes: 20,
	sha256: "a".repeat(64),
	contentUrl: "/v1/image-artifacts/old/content",
};
function gateway(change: Partial<typeof metadata> = {}) {
	const calls: Array<{ path: string; auth: string | null }> = [];
	const g = createLarmPlayground({
		baseUrl: "http://127.0.0.1:9999",
		token: "control-secret",
		profile: "normal",
		audience: "test",
		fetch: (async (url, init) => {
			const u = new URL(String(url));
			calls.push({
				path: u.pathname,
				auth: new Headers(init?.headers).get("authorization"),
			});
			if (u.pathname === "/v3/agent-profiles")
				return Response.json({
					contractVersion: "agent-connection.v3",
					requestedProfile: u.searchParams.get("profile"),
					catalogRevision: "a".repeat(64),
					profiles: [
						{
							id: "image",
							providers: [],
							services: [
								{
									name: "image",
									model: "qwen-image-2.1-turbo",
									capability: "media.image.generate",
									protocol: "larm.image-generation.v1",
									endpoint: "/v1/images/generations",
									url: "/v1/images/custom-generation",
									description: "synchronous image service",
								},
							],
						},
					],
				});
			if (u.pathname === "/v1/image-artifacts")
				return Response.json({
					images: [{ ...metadata, ...change }],
					totalBytes: 20,
					maxBytes: 100,
					targetBytes: 80,
				});
			return Response.json({ ...metadata, ...change });
		}) as typeof fetch,
	});
	return { g, calls };
}
test("image history is an authenticated read and validates the published content path", async () => {
	const { g, calls } = gateway();
	const result = await g.images.list(AbortSignal.timeout(1000));
	expect(result.images[0]!.id).toBe("old");
	await g.images.get("old", AbortSignal.timeout(1000));
	expect(calls.map((c) => c.path)).toEqual([
		"/v1/image-artifacts",
		"/v1/image-artifacts/old",
	]);
	expect(calls.every((c) => c.auth === "Bearer control-secret")).toBe(true);
});
for (const change of [
	{ contentUrl: "http://10.1.1.1/secret" },
	{ contentUrl: "/v1/image-artifacts/other/content" },
	{ mimeType: "image/webp" },
	{ id: "../old" },
])
	test("image history refuses invalid origin, binding, MIME or ID", async () => {
		const { g } = gateway(change);
		await expect(g.images.list(AbortSignal.timeout(1000))).rejects.toThrow();
	});
test("image discovery uses the selected profile and prefers returned service URL", async () => {
	const { g, calls } = gateway();
	const catalog = await g.catalog(AbortSignal.timeout(1000), ["SAAA-w-Image"]);
	expect(calls).toHaveLength(1);
	expect(catalog.targets[0]).toMatchObject({
		selector: "SAAA-w-Image",
		endpoint: "/v1/images/custom-generation",
		description: "synchronous image service",
		model: "qwen-image-2.1-turbo",
		kind: "image",
	});
});
