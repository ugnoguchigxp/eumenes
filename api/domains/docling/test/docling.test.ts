import { expect, test } from "bun:test";
import { createDocling, type DoclingConnection, type DoclingFetch } from "..";

const token = "fixture-backend-only-credential";
const relative = `/auth/exchange?ticket=${"a".repeat(43)}`;
function fixture(fetcher: DoclingFetch, timeoutMs?: number) {
	let connection: DoclingConnection | null = {
		revision: 1,
		version: "v1",
		gatewayUrl: "http://127.0.0.1:28765",
		publicOrigin: "http://localhost:28765",
		credential: token,
	};
	const service = createDocling({
		connection: () => connection,
		status: () => ({
			revision: 1,
			configured: !!connection,
			publicOrigin: connection?.publicOrigin ?? null,
		}),
		fetch: fetcher,
		timeoutMs,
	});
	return {
		service,
		change: (value: DoclingConnection | null) => {
			connection = value;
		},
	};
}
const json = (value: unknown) => Response.json(value);

test("one gateway POST wakes the app and returns only a browser URL; status and prepare never connect", async () => {
	let calls = 0;
	const { service } = fixture((async (url, init) => {
		calls++;
		expect(String(url)).toBe("http://127.0.0.1:28765/auth/ui-tickets");
		expect(init?.method).toBe("POST");
		expect(init?.redirect).toBe("manual");
		const headers = new Headers(init?.headers);
		expect(headers.get("authorization")).toBe(`Bearer ${token}`);
		expect(headers.get("host")).toBe("127.0.0.1:28765");
		expect(headers.has("cookie")).toBe(false);
		return json({ url: relative, expires_in: 60 });
	}) as DoclingFetch);
	expect(service.status().configured).toBe(true);
	expect(service.prepare().state).toBe("ready_for_open");
	expect(calls).toBe(0);
	const value = await service.ticket(new AbortController().signal);
	expect(value.url).toBe(`http://localhost:28765${relative}`);
	expect(value.expiresIn).toBeGreaterThan(0);
	expect(JSON.stringify(value)).not.toContain(token);
	expect(calls).toBe(1);
});

test("concurrent open is refused, with no second POST or shared ticket", async () => {
	let resolve!: (value: Response) => void,
		calls = 0;
	const { service } = fixture((async () => {
		calls++;
		return new Promise<Response>((r) => {
			resolve = r;
		});
	}) as DoclingFetch);
	const first = service.ticket(new AbortController().signal);
	await expect(service.ticket(new AbortController().signal)).rejects.toThrow(
		"docling_open_in_progress",
	);
	resolve(json({ url: relative, expires_in: 60 }));
	await first;
	expect(calls).toBe(1);
});

test("untrusted response URLs, expired tickets and oversized bodies are refused", async () => {
	for (const body of [
		{ url: `https://other.invalid${relative}`, expires_in: 60 },
		{
			url: `/auth/exchange?ticket=${"a".repeat(43)}&next=//other.invalid`,
			expires_in: 60,
		},
		{ url: `${relative}#fragment`, expires_in: 60 },
		{ url: "/auth/exchange?ticket=short", expires_in: 60 },
		{ url: relative, expires_in: 0 },
		{ url: relative, expires_in: 61 },
		{ url: relative, expires_in: "60" },
		{ url: relative, expires_in: 60, padding: "a".repeat(8192) },
	]) {
		const { service } = fixture((async () => json(body)) as DoclingFetch);
		await expect(service.ticket(new AbortController().signal)).rejects.toThrow(
			"docling_invalid_response",
		);
	}
});

test("upstream auth, redirect and network failures never expose body, URL or credential and never retry", async () => {
	for (const status of [401, 403, 303, 503]) {
		let calls = 0;
		const { service } = fixture((async () => {
			calls++;
			return new Response(token, {
				status,
				headers: { Location: "https://other.invalid" },
			});
		}) as DoclingFetch);
		await expect(service.ticket(new AbortController().signal)).rejects.toThrow(
			[401, 403].includes(status)
				? "docling_auth_failed"
				: "docling_upstream_failed",
		);
		expect(calls).toBe(1);
	}
	const { service } = fixture((async () => {
		throw new TypeError(token);
	}) as DoclingFetch);
	await expect(service.ticket(new AbortController().signal)).rejects.toThrow(
		"docling_unreachable",
	);
});

test("cancellation and configuration change discard late responses", async () => {
	for (const action of ["cancel", "change"] as const) {
		let resolve!: (r: Response) => void;
		const h = fixture(
			(async () =>
				new Promise<Response>((r) => {
					resolve = r;
				})) as DoclingFetch,
		);
		const controller = new AbortController();
		const pending = h.service.ticket(controller.signal);
		if (action === "cancel") controller.abort();
		else h.change(null);
		resolve(json({ url: relative, expires_in: 60 }));
		await expect(pending).rejects.toThrow(
			action === "cancel" ? "docling_cancelled" : "docling_connection_changed",
		);
	}
});

test("deadline aborts one request; next explicit attempt is possible", async () => {
	const { service } = fixture(
		(async (_url, init) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener(
					"abort",
					() => reject(new Error(token)),
					{ once: true },
				);
			})) as DoclingFetch,
		10,
	);
	await expect(service.ticket(new AbortController().signal)).rejects.toThrow(
		"docling_timeout",
	);
	await expect(service.ticket(new AbortController().signal)).rejects.toThrow(
		"docling_timeout",
	);
});
