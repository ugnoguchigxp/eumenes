import { expect, test } from "bun:test";
import { startDotsGateway } from "./dots-gateway";
test("public ingress never forwards a control route, cookie or unmarked local bearer request", async () => {
	const requests: Headers[] = [];
	const upstream = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (req) => {
				requests.push(new Headers(req.headers));
				return Response.json({ ok: true });
			},
		}),
		gateway = startDotsGateway({
			upstream: `http://127.0.0.1:${upstream.port}`,
			connectionRef: "dots",
			publicResource: "https://public.example/mcp/dots/dots",
			port: 0,
		});
	try {
		const url = `http://127.0.0.1:${gateway.port}`;
		expect(
			(
				await fetch(url + "/api/settings", {
					headers: { authorization: "Bearer private" },
				})
			).status,
		).toBe(404);
		expect(requests).toHaveLength(0);
		expect(
			(
				await fetch(url + "/mcp/dots/dots", {
					method: "POST",
					headers: { authorization: "Bearer access", cookie: "private=value" },
					body: "{}",
				})
			).status,
		).toBe(200);
		expect(requests[0]!.get("cookie")).toBeNull();
		expect(requests[0]!.get("x-forwarded-proto")).toBe("https");
		expect(requests[0]!.get("authorization")).toBe("Bearer access");
	} finally {
		gateway.stop(true);
		upstream.stop(true);
	}
});
