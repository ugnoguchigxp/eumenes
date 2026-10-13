import { expect, test } from "bun:test";
import { createLarmPlayground } from "..";
function fixture(response: () => Response) {
	const calls: Array<{ path: string; method: string; auth: string | null }> =
		[];
	const gateway = createLarmPlayground({
		baseUrl: "http://127.0.0.1:9999",
		token: "control-secret",
		profile: "normal",
		audience: "test",
		fetch: (async (url, init) => {
			calls.push({
				path: new URL(String(url)).pathname,
				method: init?.method ?? "GET",
				auth: new Headers(init?.headers).get("authorization"),
			});
			return response();
		}) as typeof fetch,
	});
	return { gateway, calls };
}
test("image deletion uses the authenticated Control API once and requires a matching receipt", async () => {
	const f = fixture(() => Response.json({ id: "old", deleted: true }));
	expect(
		await f.gateway.images.remove("old", AbortSignal.timeout(1000)),
	).toEqual({ id: "old", deleted: true });
	expect(f.calls).toEqual([
		{
			path: "/v1/image-artifacts/old",
			method: "DELETE",
			auth: "Bearer control-secret",
		},
	]);
	await expect(
		f.gateway.images.remove("../old", AbortSignal.timeout(1000)),
	).rejects.toThrow();
	expect(f.calls).toHaveLength(1);
});
for (const receipt of [
	{ id: "other", deleted: true },
	{ id: "old", deleted: false },
	{ id: "old" },
])
	test("invalid or mismatched image deletion receipts are not adopted", async () => {
		const f = fixture(() => Response.json(receipt));
		await expect(
			f.gateway.images.remove("old", AbortSignal.timeout(1000)),
		).rejects.toThrow();
		expect(f.calls).toHaveLength(1);
	});
for (const status of [404, 503])
	test(`image DELETE ${status} is reported without automatic retry`, async () => {
		const f = fixture(() => new Response(null, { status }));
		await expect(
			f.gateway.images.remove("old", AbortSignal.timeout(1000)),
		).rejects.toThrow(`larm_http_${status}`);
		expect(f.calls).toHaveLength(1);
	});
