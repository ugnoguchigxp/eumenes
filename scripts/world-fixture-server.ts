import { worldHarness } from "../api/application/world-claims.fixture";
const h = await worldHarness({
	...(process.env.WORLD_FIXTURE_DIR
		? { dir: process.env.WORLD_FIXTURE_DIR }
		: {}),
	stallForget: process.env.WORLD_FIXTURE_STALL === "1",
	pollMs: Number(process.env.WORLD_FIXTURE_POLL_MS ?? 60_000),
});
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: Number(process.env.EUMENES_PORT ?? 0),
	fetch: h.app.fetch,
});
console.log(JSON.stringify({ port: server.port }));
process.on("SIGTERM", () => {
	void (async () => {
		server.stop(true);
		await h.close();
		process.exit(0);
	})();
});
