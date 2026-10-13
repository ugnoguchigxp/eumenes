import { harness } from "../api/application/toolchain.fixture";
import { imageLarmFixture } from "../api/domains/larm/test/chat-input.fixture";
const f = imageLarmFixture();
await f.p.connect();
const h = await harness({ model: f.p, timers: true });
h.app.get("/api/chat-image-fixture/requests", (c) =>
	c.json(
		f.requests.map((r) => ({
			operation: r.operation,
			body: JSON.parse(r.body),
		})),
	),
);
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: Number(process.env.EUMENES_PORT ?? 0),
	fetch: h.app.fetch,
	idleTimeout: 60,
});
console.log(JSON.stringify({ port: server.port }));
process.on("SIGTERM", () => {
	void (async () => {
		server.stop(true);
		await h.close();
		await f.p.close();
		process.exit(0);
	})();
});
