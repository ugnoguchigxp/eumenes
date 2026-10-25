import { afterEach, expect, test, vi } from "vitest";
import { createClient } from ".";
afterEach(() => vi.unstubAllGlobals());
test("messaging enable uses authenticated PUT and does not change the base connection", async () => {
	const fetcher = vi.fn(
		async (_input: RequestInfo | URL, _init?: RequestInit) =>
			new Response(
				JSON.stringify({
					connectionRef: "conn",
					enabled: true,
					revision: 1,
					epoch: 1,
					verifiedAt: null,
				}),
				{ headers: { "content-type": "application/json" } },
			),
	);
	vi.stubGlobal("fetch", fetcher);
	const c = createClient("http://127.0.0.1:8787", "test-token");
	await c.configureDotsMessaging("conn", 0, true);
	expect(fetcher.mock.calls[0]?.[0].toString()).toBe(
		"http://127.0.0.1:8787/api/dots/connections/conn/messaging",
	);
	const init = fetcher.mock.calls[0]?.[1];
	expect(init?.method).toBe("PUT");
	expect(new Headers(init?.headers).get("authorization")).toBe(
		"Bearer test-token",
	);
	expect(JSON.parse(String(init?.body))).toEqual({
		enabled: true,
		expectedRevision: 0,
	});
});
