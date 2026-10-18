import { afterEach, expect, test, vi } from "vitest";
import { larmClient } from "./larm";
import { createTransport } from "./transport";

afterEach(() => vi.unstubAllGlobals());

test("screen notification keeps the existing API authentication and supports delivery while leaving", async () => {
	const request = vi.fn(
		async (_input: RequestInfo | URL, _init?: RequestInit) =>
			new Response(null, { status: 204 }),
	);
	vi.stubGlobal("fetch", request);
	const client = larmClient(
		createTransport("http://localhost:3000", "existing-backend-token"),
	);
	const id = crypto.randomUUID();
	await client.screenPresence(id, 4, false, 100);
	const [url, init] = request.mock.calls[0]!;
	expect(String(url)).toBe(`http://localhost:3000/api/inference/screen/${id}`);
	expect(init?.method).toBe("PUT");
	expect(new Headers(init?.headers).get("Authorization")).toBe(
		"Bearer existing-backend-token",
	);
	expect(JSON.parse(String(init?.body))).toEqual({
		revision: 4,
		active: false,
		sentAt: 100,
	});
	expect(init?.keepalive).toBe(true);
});
